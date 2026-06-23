import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatMicros, parseMicros } from "../decimal";
import { aggregateForMode, aggregationMode } from "./determinism";
import type { MeteringEngine } from "./engine";
import type {
  BillingWindow,
  CorrectionRecord,
  EventDisposition,
  IngestOptions,
  IngestResult,
  LoggedEvent,
  SealResult,
  UsageEvent,
  WatermarkState,
  WindowFilter,
  WindowTotal,
} from "./types";
import { uuidv7 } from "../uuidv7";
import { windowForEvent } from "./windowing";

export interface MemoryEngineOptions {
  latenessGraceMs: number;
  windowMs: number;
  /** Durable write-ahead log path. When set, the log survives a process crash. */
  walPath?: string | null;
  /** Clock for processing-time stamps. Injectable for deterministic tests. */
  now?: () => number;
}

interface StreamState {
  customerId: string;
  metric: string;
  maxEventTime: number; // max admitted event_time seen
}

type WalRecord =
  | { t: "event"; e: SerializedLoggedEvent }
  | { t: "seal"; windowKey: string; sealedAt: number; sealedWatermark: number }
  | { t: "correction"; c: CorrectionRecord };

interface SerializedLoggedEvent {
  eventId: string;
  customerId: string;
  metric: string;
  quantityMicros: string;
  eventTime: number;
  ingestTime: number;
  payload: Record<string, unknown>;
}

/**
 * In-memory metering engine. Faithfully reproduces the load-bearing invariant —
 * event-time watermarks, window sealing, late-after-seal quarantine, and the
 * total-order aggregation rule — with zero cloud dependencies. The Aurora engine
 * must agree with it byte-for-byte for every seed.
 */
export class MemoryMeteringEngine implements MeteringEngine {
  readonly backend = "memory" as const;

  private readonly log = new Map<string, LoggedEvent>();
  private readonly streams = new Map<string, StreamState>();
  private readonly windowMap = new Map<string, BillingWindow>();
  private readonly correctionLog: CorrectionRecord[] = [];
  private readonly correctedIds = new Set<string>();

  private readonly latenessGraceMs: number;
  private readonly windowMs: number;
  private readonly walPath: string | null;
  private readonly clock: () => number;

  constructor(opts: MemoryEngineOptions) {
    this.latenessGraceMs = opts.latenessGraceMs;
    this.windowMs = opts.windowMs;
    this.walPath = opts.walPath ?? null;
    this.clock = opts.now ?? Date.now;
    if (this.walPath) this.replayWal(this.walPath);
  }

  async ingest(events: UsageEvent[], opts: IngestOptions = {}): Promise<IngestResult> {
    const dispositions: EventDisposition[] = [];
    let accepted = 0;
    let deduped = 0;
    let quarantined = 0;
    const touchedStreams = new Set<string>();

    for (const raw of events) {
      const ev = this.validate(raw);
      const spec = windowForEvent(ev.customerId, ev.metric, ev.eventTime, this.windowMs);
      const existingWindow = this.windowMap.get(spec.windowKey);

      // Idempotent dedup on event_id (plumbing) — checked FIRST. A re-delivery of
      // an already-admitted event is already counted; it is a duplicate, not a
      // late rewrite, even if its window has since sealed. Quarantining it would
      // mislabel an already-billed event in the audit trail.
      //
      // event_id is the idempotency key: deliveries of the same id MUST carry the
      // same billable payload. The append-only log is never mutated, so the
      // first-admitted value is authoritative. A re-delivery whose quantity
      // DIFFERS is a contract violation; rather than silently first-write-wins
      // (which would make the total arrival-order-dependent), we detect it and
      // record an audited `payload_conflict` — the sealed/open total never moves.
      const existing = this.log.get(ev.eventId);
      if (existing) {
        if (existing.quantityMicros !== parseMicros(ev.quantity)) {
          this.recordConflict(existing, parseMicros(ev.quantity));
        }
        deduped++;
        dispositions.push({ eventId: ev.eventId, disposition: "deduped" });
        continue;
      }

      // Late-after-seal: a NEW event whose target window is already sealed. It is
      // NOT merged into the sealed total; it is quarantined into the correction
      // epoch. The sealed number cannot move.
      if (existingWindow && existingWindow.state === "sealed") {
        if (!this.correctedIds.has(ev.eventId)) {
          const correction: CorrectionRecord = {
            correctionId: uuidv7(this.clock()),
            windowKey: spec.windowKey,
            eventId: ev.eventId,
            customerId: ev.customerId,
            metric: ev.metric,
            quantity: formatMicros(parseMicros(ev.quantity)),
            eventTime: ev.eventTime,
            quarantinedAt: ev.ingestTime ?? this.clock(),
            reason: "late_after_seal",
          };
          this.correctionLog.push(correction);
          this.correctedIds.add(ev.eventId);
          this.wal({ t: "correction", c: correction });
        }
        quarantined++;
        dispositions.push({ eventId: ev.eventId, disposition: "quarantined", windowKey: spec.windowKey });
        continue;
      }

      const logged: LoggedEvent = {
        eventId: ev.eventId,
        customerId: ev.customerId,
        metric: ev.metric,
        quantityMicros: parseMicros(ev.quantity),
        eventTime: ev.eventTime,
        ingestTime: ev.ingestTime ?? this.clock(),
        payload: ev.payload ?? {},
      };
      this.log.set(logged.eventId, logged);
      this.ensureWindow(spec.windowKey, spec.customerId, spec.metric, spec.windowOpen, spec.windowClose);
      this.observeStream(logged);
      this.wal({ t: "event", e: serializeLogged(logged) });
      accepted++;
      dispositions.push({ eventId: ev.eventId, disposition: "accepted" });
      touchedStreams.add(streamKey(ev.customerId, ev.metric));
    }

    if (opts.autoSeal) await this.sealDueWindows(this.clock());

    return { accepted, deduped, quarantined, dispositions };
  }

  async sealDueWindows(now: number = this.clock()): Promise<SealResult> {
    const newlySealed: string[] = [];
    for (const w of this.windowMap.values()) {
      if (w.state !== "open") continue;
      const wm = this.streamWatermark(w.customerId, w.metric);
      if (wm === null) continue;
      if (w.windowClose <= wm) {
        w.state = "sealed";
        w.sealedAt = now;
        w.sealedWatermark = wm;
        newlySealed.push(w.windowKey);
        this.wal({ t: "seal", windowKey: w.windowKey, sealedAt: now, sealedWatermark: wm });
      }
    }
    return { newlySealed, windows: this.snapshotWindows() };
  }

  async windowTotal(windowKey: string): Promise<WindowTotal> {
    const w = this.windowMap.get(windowKey);
    if (!w) {
      // Derive mode from the window key's metric segment for an empty window.
      const metric = windowKey.split(":")[1] ?? "";
      return {
        windowKey,
        billedTotal: formatMicros(0n),
        billedTotalMicros: "0",
        sealed: false,
        sealedWatermark: null,
        eventCount: 0,
        mode: aggregationMode(metric),
      };
    }
    const mode = aggregationMode(w.metric);
    const { micros, eventCount } = aggregateForMode(this.log.values(), w, mode);
    return {
      windowKey,
      billedTotal: formatMicros(micros),
      billedTotalMicros: micros.toString(),
      sealed: w.state === "sealed",
      sealedWatermark: w.sealedWatermark,
      eventCount,
      mode,
    };
  }

  async corrections(windowKey: string): Promise<CorrectionRecord[]> {
    return this.correctionLog.filter((c) => c.windowKey === windowKey);
  }

  async watermark(customerId: string, metric: string): Promise<WatermarkState | null> {
    const wm = this.streamWatermark(customerId, metric);
    if (wm === null) return null;
    return { customerId, metric, watermark: wm, latenessGraceMs: this.latenessGraceMs };
  }

  async windows(filter?: WindowFilter): Promise<BillingWindow[]> {
    return this.snapshotWindows().filter(
      (w) =>
        (!filter?.customerId || w.customerId === filter.customerId) &&
        (!filter?.metric || w.metric === filter.metric),
    );
  }

  async reset(): Promise<void> {
    this.log.clear();
    this.streams.clear();
    this.windowMap.clear();
    this.correctionLog.length = 0;
    this.correctedIds.clear();
    if (this.walPath) {
      mkdirSync(dirname(this.walPath), { recursive: true });
      writeFileSync(this.walPath, "");
    }
  }

  async close(): Promise<void> {
    // appendFileSync flushes per write; nothing to release.
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Record an audited payload conflict for a re-delivered id whose quantity
   * differs from the first-admitted (authoritative) value. Idempotent. */
  private recordConflict(existing: LoggedEvent, conflictingMicros: bigint): void {
    if (this.correctedIds.has(existing.eventId)) return;
    const spec = windowForEvent(existing.customerId, existing.metric, existing.eventTime, this.windowMs);
    const correction: CorrectionRecord = {
      correctionId: uuidv7(this.clock()),
      windowKey: spec.windowKey,
      eventId: existing.eventId,
      customerId: existing.customerId,
      metric: existing.metric,
      quantity: formatMicros(conflictingMicros), // the rejected, conflicting value
      eventTime: existing.eventTime,
      quarantinedAt: this.clock(),
      reason: "payload_conflict",
    };
    this.correctionLog.push(correction);
    this.correctedIds.add(existing.eventId);
    this.wal({ t: "correction", c: correction });
  }

  private streamWatermark(customerId: string, metric: string): number | null {
    const s = this.streams.get(streamKey(customerId, metric));
    if (!s) return null;
    return s.maxEventTime - this.latenessGraceMs;
  }

  private observeStream(e: LoggedEvent): void {
    const key = streamKey(e.customerId, e.metric);
    const existing = this.streams.get(key);
    if (!existing) {
      this.streams.set(key, { customerId: e.customerId, metric: e.metric, maxEventTime: e.eventTime });
    } else if (e.eventTime > existing.maxEventTime) {
      existing.maxEventTime = e.eventTime;
    }
  }

  private ensureWindow(
    windowKey: string,
    customerId: string,
    metric: string,
    windowOpen: number,
    windowClose: number,
  ): void {
    if (this.windowMap.has(windowKey)) return;
    this.windowMap.set(windowKey, {
      windowKey,
      customerId,
      metric,
      windowOpen,
      windowClose,
      state: "open",
      sealedAt: null,
      sealedWatermark: null,
    });
  }

  private snapshotWindows(): BillingWindow[] {
    return [...this.windowMap.values()]
      .map((w) => ({ ...w }))
      .sort((a, b) => (a.windowKey < b.windowKey ? -1 : a.windowKey > b.windowKey ? 1 : 0));
  }

  private validate(raw: UsageEvent): UsageEvent {
    if (!raw || typeof raw !== "object") throw new Error("event must be an object");
    if (typeof raw.eventId !== "string" || raw.eventId === "")
      throw new Error("event.eventId must be a non-empty string");
    if (typeof raw.customerId !== "string" || raw.customerId === "")
      throw new Error("event.customerId must be a non-empty string");
    if (typeof raw.metric !== "string" || raw.metric === "")
      throw new Error("event.metric must be a non-empty string");
    if (!Number.isFinite(raw.eventTime))
      throw new Error("event.eventTime must be a finite epoch-ms number");
    parseMicros(raw.quantity); // throws on invalid quantity
    return raw;
  }

  // ── durable write-ahead log (mirrors Aurora's durable append-only log) ──────

  private wal(record: WalRecord): void {
    if (!this.walPath) return;
    mkdirSync(dirname(this.walPath), { recursive: true });
    appendFileSync(this.walPath, JSON.stringify(record) + "\n");
  }

  private replayWal(path: string): void {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const rec = JSON.parse(line) as WalRecord;
      if (rec.t === "event") {
        const logged = deserializeLogged(rec.e);
        this.log.set(logged.eventId, logged);
        const spec = windowForEvent(logged.customerId, logged.metric, logged.eventTime, this.windowMs);
        this.ensureWindow(spec.windowKey, spec.customerId, spec.metric, spec.windowOpen, spec.windowClose);
        this.observeStream(logged);
      } else if (rec.t === "seal") {
        const w = this.windowMap.get(rec.windowKey);
        if (w) {
          w.state = "sealed";
          w.sealedAt = rec.sealedAt;
          w.sealedWatermark = rec.sealedWatermark;
        }
      } else {
        this.correctionLog.push(rec.c);
        this.correctedIds.add(rec.c.eventId);
      }
    }
  }
}

function streamKey(customerId: string, metric: string): string {
  return `${customerId}:${metric}`;
}

function serializeLogged(e: LoggedEvent): SerializedLoggedEvent {
  return { ...e, quantityMicros: e.quantityMicros.toString() };
}

function deserializeLogged(e: SerializedLoggedEvent): LoggedEvent {
  return { ...e, quantityMicros: BigInt(e.quantityMicros) };
}
