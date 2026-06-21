import { existsSync, readFileSync } from "node:fs";

import { Pool } from "pg";

import { formatMicros, parseMicros } from "../decimal";
import {
  AGGREGATE_SQL,
  SCHEMA_SQL,
  SEAL_DUE_SQL,
  UPSERT_WATERMARK_SQL,
} from "../sql/statements";
import { uuidv7 } from "../uuidv7";
import type { MeteringEngine } from "./engine";
import type {
  BillingWindow,
  CorrectionRecord,
  EventDisposition,
  IngestOptions,
  IngestResult,
  SealResult,
  UsageEvent,
  WatermarkState,
  WindowFilter,
  WindowTotal,
} from "./types";
import { windowForEvent, type WindowSpec } from "./windowing";

export interface AuroraEngineOptions {
  writerUrl: string | undefined;
  readerUrl: string | undefined;
  latenessGraceMs: number;
  windowMs: number;
  /** RDS CA bundle (PEM or file path) to pin TLS. Falls back to trust-all. */
  caCert?: string | undefined;
}

/**
 * Aurora PostgreSQL Serverless v2 engine. Writes hit the WRITER endpoint
 * (append-only inserts); the heavy deterministic aggregation runs on the
 * Optimized-Reads READER endpoint, isolated from ingest pressure. Both endpoints
 * are reached through RDS Proxy so serverless functions never storm Postgres.
 *
 * Every operation mirrors the in-memory engine exactly. The deterministic SQL is
 * the source of truth here; for any seed the two backends produce the identical
 * billed total.
 */
export class AuroraMeteringEngine implements MeteringEngine {
  readonly backend = "aurora" as const;

  private readonly writer: Pool;
  private readonly reader: Pool;
  private readonly latenessGraceMs: number;
  private readonly windowMs: number;

  constructor(opts: AuroraEngineOptions) {
    if (!opts.writerUrl) {
      throw new Error("AURORA_WRITER_URL is required for the aurora backend");
    }
    this.latenessGraceMs = opts.latenessGraceMs;
    this.windowMs = opts.windowMs;
    const readerUrl = opts.readerUrl ?? opts.writerUrl;
    this.writer = new Pool({
      connectionString: pgConnString(opts.writerUrl),
      max: 10,
      ssl: sslFor(opts.writerUrl, opts.caCert),
    });
    this.reader = new Pool({
      connectionString: pgConnString(readerUrl),
      max: 10,
      ssl: sslFor(readerUrl, opts.caCert),
    });
  }

  /** Apply the schema (idempotent). Safe to call on every cold start. */
  async init(): Promise<void> {
    await this.writer.query(SCHEMA_SQL);
  }

  async ingest(events: UsageEvent[], opts: IngestOptions = {}): Promise<IngestResult> {
    const dispositions: EventDisposition[] = [];
    let accepted = 0;
    let deduped = 0;
    let quarantined = 0;
    if (events.length === 0) return { accepted, deduped, quarantined, dispositions };

    // Precompute per event once (validate + window derivation).
    const items: IngestItem[] = events.map((raw) => {
      const ev = validate(raw);
      return {
        ev,
        micros: parseMicros(ev.quantity),
        spec: windowForEvent(ev.customerId, ev.metric, ev.eventTime, this.windowMs),
        ingestTimeMs: ev.ingestTime ?? Date.now(),
      };
    });

    const client = await this.writer.connect();
    try {
      await client.query("BEGIN");

      // 1. Ensure every distinct (open) window exists — one bulk INSERT.
      const windowsByKey = new Map<string, WindowSpec>();
      for (const it of items) if (!windowsByKey.has(it.spec.windowKey)) windowsByKey.set(it.spec.windowKey, it.spec);
      await bulkEnsureWindows(client, [...windowsByKey.values()]);

      // 2. Which of those windows are already sealed? — one query.
      const sealedRes = await client.query<{ window_key: string }>(
        "SELECT window_key FROM billing_window WHERE state = 'sealed' AND window_key = ANY($1)",
        [[...windowsByKey.keys()]],
      );
      const sealed = new Set(sealedRes.rows.map((r) => r.window_key));

      // 3. Existing events for dedup / payload-conflict detection — one query.
      const existingRes = await client.query<ExistingRow>(
        "SELECT event_id, quantity_micros, customer_id, metric, event_time_ms FROM event_log WHERE event_id = ANY($1)",
        [items.map((it) => it.ev.eventId)],
      );
      const existing = new Map(existingRes.rows.map((r) => [r.event_id, r]));

      // 4. Partition in JS — identical semantics to the memory engine.
      const admit: IngestItem[] = [];
      const corrections: CorrectionRow[] = [];
      const correctedIds = new Set<string>(); // one correction per event_id
      const seenInBatch = new Map<string, { micros: string; eventTimeMs: number; windowKey: string }>();
      const touched = new Map<string, { customerId: string; metric: string }>();

      for (const it of items) {
        const id = it.ev.eventId;
        const prior = existing.get(id);
        const priorBatch = seenInBatch.get(id);

        // Already known (in the log or earlier in this batch) → dedup. event_id is
        // the idempotency key; a re-delivery whose quantity DIFFERS is a contract
        // violation recorded as an audited payload_conflict (log never mutated).
        if (prior || priorBatch) {
          const priorMicros = prior ? prior.quantity_micros : priorBatch!.micros;
          if (priorMicros !== it.micros.toString() && !correctedIds.has(id)) {
            const windowKey = prior
              ? windowForEvent(prior.customer_id, prior.metric, Number(prior.event_time_ms), this.windowMs).windowKey
              : priorBatch!.windowKey;
            corrections.push({
              windowKey,
              eventId: id,
              customerId: it.ev.customerId,
              metric: it.ev.metric,
              micros: it.micros, // the rejected, conflicting value
              eventTimeMs: prior ? Number(prior.event_time_ms) : priorBatch!.eventTimeMs,
              ingestTimeMs: it.ingestTimeMs,
              reason: "payload_conflict",
            });
            correctedIds.add(id);
          }
          deduped++;
          dispositions.push({ eventId: id, disposition: "deduped" });
          continue;
        }

        // A NEW event whose target window is already sealed → quarantine.
        if (sealed.has(it.spec.windowKey)) {
          if (!correctedIds.has(id)) {
            corrections.push({
              windowKey: it.spec.windowKey,
              eventId: id,
              customerId: it.ev.customerId,
              metric: it.ev.metric,
              micros: it.micros,
              eventTimeMs: it.ev.eventTime,
              ingestTimeMs: it.ingestTimeMs,
              reason: "late_after_seal",
            });
            correctedIds.add(id);
          }
          quarantined++;
          dispositions.push({ eventId: id, disposition: "quarantined", windowKey: it.spec.windowKey });
          continue;
        }

        // Admit.
        admit.push(it);
        seenInBatch.set(id, { micros: it.micros.toString(), eventTimeMs: it.ev.eventTime, windowKey: it.spec.windowKey });
        touched.set(`${it.ev.customerId}:${it.ev.metric}`, { customerId: it.ev.customerId, metric: it.ev.metric });
        accepted++;
        dispositions.push({ eventId: id, disposition: "accepted" });
      }

      // 5–6. Bulk insert admitted events and corrections.
      await bulkInsertEvents(client, admit);
      await bulkInsertCorrections(client, corrections);

      // 7. Advance watermarks for touched streams (recomputed from the log).
      for (const { customerId, metric } of touched.values()) {
        await client.query(UPSERT_WATERMARK_SQL, [customerId, metric, this.latenessGraceMs]);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (opts.autoSeal) await this.sealDueWindows();

    return { accepted, deduped, quarantined, dispositions };
  }

  async sealDueWindows(now: number = Date.now()): Promise<SealResult> {
    const res = await this.writer.query<{ window_key: string }>(SEAL_DUE_SQL, [now]);
    return { newlySealed: res.rows.map((r) => r.window_key), windows: await this.windows() };
  }

  async windowTotal(windowKey: string): Promise<WindowTotal> {
    // The window metadata read and the heavy aggregation run inside ONE
    // read-only REPEATABLE READ transaction on the READER endpoint, so both
    // observe a single MVCC snapshot — making "single-snapshot total order"
    // literally true, not two independent autocommit snapshots.
    const client = await this.reader.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const meta = await client.query<{ state: string; sealed_watermark_ms: string | null }>(
        "SELECT state, sealed_watermark_ms FROM billing_window WHERE window_key = $1",
        [windowKey],
      );
      if (meta.rows.length === 0) {
        await client.query("COMMIT");
        return { windowKey, billedTotal: formatMicros(0n), billedTotalMicros: "0", sealed: false, sealedWatermark: null, eventCount: 0 };
      }
      const agg = await client.query<{ billed_total_micros: string; event_count: number }>(AGGREGATE_SQL, [windowKey]);
      await client.query("COMMIT");

      const micros = BigInt(agg.rows[0]?.billed_total_micros ?? "0");
      const sealedWatermark = meta.rows[0]!.sealed_watermark_ms;
      return {
        windowKey,
        billedTotal: formatMicros(micros),
        billedTotalMicros: micros.toString(),
        sealed: meta.rows[0]!.state === "sealed",
        sealedWatermark: sealedWatermark === null ? null : Number(sealedWatermark),
        eventCount: agg.rows[0]?.event_count ?? 0,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async corrections(windowKey: string): Promise<CorrectionRecord[]> {
    const res = await this.reader.query(
      `SELECT correction_id, window_key, event_id, customer_id, metric, quantity::text AS quantity,
              event_time_ms, quarantined_at_ms, reason
       FROM correction_epoch WHERE window_key = $1
       ORDER BY event_time_ms, event_id`,
      [windowKey],
    );
    return res.rows.map((r) => ({
      correctionId: r.correction_id,
      windowKey: r.window_key,
      eventId: r.event_id,
      customerId: r.customer_id,
      metric: r.metric,
      quantity: formatMicros(parseMicros(r.quantity)),
      eventTime: Number(r.event_time_ms),
      quarantinedAt: Number(r.quarantined_at_ms),
      reason: r.reason,
    }));
  }

  async watermark(customerId: string, metric: string): Promise<WatermarkState | null> {
    const res = await this.reader.query<{ watermark_ms: string; lateness_grace_ms: string }>(
      "SELECT watermark_ms, lateness_grace_ms FROM stream_watermark WHERE customer_id = $1 AND metric = $2",
      [customerId, metric],
    );
    if (res.rows.length === 0) return null;
    return {
      customerId,
      metric,
      watermark: Number(res.rows[0]!.watermark_ms),
      latenessGraceMs: Number(res.rows[0]!.lateness_grace_ms),
    };
  }

  async windows(filter?: WindowFilter): Promise<BillingWindow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.customerId) {
      params.push(filter.customerId);
      clauses.push(`customer_id = $${params.length}`);
    }
    if (filter?.metric) {
      params.push(filter.metric);
      clauses.push(`metric = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.reader.query(
      `SELECT window_key, customer_id, metric, window_open_ms, window_close_ms, state, sealed_at_ms, sealed_watermark_ms
       FROM billing_window ${where} ORDER BY window_key`,
      params,
    );
    return res.rows.map((r) => ({
      windowKey: r.window_key,
      customerId: r.customer_id,
      metric: r.metric,
      windowOpen: Number(r.window_open_ms),
      windowClose: Number(r.window_close_ms),
      state: r.state,
      sealedAt: r.sealed_at_ms === null ? null : Number(r.sealed_at_ms),
      sealedWatermark: r.sealed_watermark_ms === null ? null : Number(r.sealed_watermark_ms),
    }));
  }

  async reset(): Promise<void> {
    await this.init();
    await this.writer.query("TRUNCATE correction_epoch, event_log, billing_window, stream_watermark");
  }

  /**
   * Scoped delete of specific customers' rows — used by the in-app replay proof
   * to clean up its isolated namespace without touching the live timeline.
   */
  async purgeCustomers(customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) return;
    const client = await this.writer.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM correction_epoch WHERE customer_id = ANY($1::uuid[])", [customerIds]);
      await client.query("DELETE FROM event_log WHERE customer_id = ANY($1::uuid[])", [customerIds]);
      await client.query("DELETE FROM billing_window WHERE customer_id = ANY($1::uuid[])", [customerIds]);
      await client.query("DELETE FROM stream_watermark WHERE customer_id = ANY($1::uuid[])", [customerIds]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.writer.end(), this.reader.end()]);
  }
}

export type SslConfig = false | { rejectUnauthorized: boolean; ca?: string };

/**
 * Strip ssl-related query params from the connection string. pg v9+ parses
 * `sslmode=require` as `verify-full` and lets it override an explicit `ssl`
 * option — which fails against RDS without the CA bundle
 * (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). We drop those params and drive TLS solely
 * via the `ssl` object returned by sslFor().
 */
export function pgConnString(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("ssl");
    u.searchParams.delete("uselibpqcompat");
    return u.toString();
  } catch {
    return url.replace(/[?&]sslmode=[^&]*/gi, "").replace(/[?&]uselibpqcompat=[^&]*/gi, "");
  }
}

export function sslFor(url: string | undefined, caCert?: string): SslConfig {
  if (!url) return false;
  // Aurora always uses TLS. With a CA bundle we verify the chain (production
  // posture); otherwise we still encrypt but skip issuer verification — set
  // AURORA_CA_CERT (PEM or path) to pin the RDS CA.
  if (caCert) {
    const ca = caCert.includes("BEGIN CERTIFICATE")
      ? caCert // inline PEM
      : existsSync(caCert)
        ? readFileSync(caCert, "utf8") // file path
        : caCert;
    return { rejectUnauthorized: true, ca };
  }
  return { rejectUnauthorized: false };
}

function validate(raw: UsageEvent): UsageEvent {
  if (!raw || typeof raw !== "object") throw new Error("event must be an object");
  if (typeof raw.eventId !== "string" || raw.eventId === "")
    throw new Error("event.eventId must be a non-empty string");
  if (typeof raw.customerId !== "string" || raw.customerId === "")
    throw new Error("event.customerId must be a non-empty string");
  if (typeof raw.metric !== "string" || raw.metric === "")
    throw new Error("event.metric must be a non-empty string");
  if (!Number.isFinite(raw.eventTime))
    throw new Error("event.eventTime must be a finite epoch-ms number");
  parseMicros(raw.quantity);
  return raw;
}

// ── set-based ingest helpers ──────────────────────────────────────────────────

interface IngestItem {
  ev: UsageEvent;
  micros: bigint;
  spec: WindowSpec;
  ingestTimeMs: number;
}

interface ExistingRow {
  event_id: string;
  quantity_micros: string;
  customer_id: string;
  metric: string;
  event_time_ms: string;
}

interface CorrectionRow {
  windowKey: string;
  eventId: string;
  customerId: string;
  metric: string;
  micros: bigint;
  eventTimeMs: number;
  ingestTimeMs: number;
  reason: string;
}

/** One multi-row placeholder group, e.g. ($1,$2,$3) with an optional ::jsonb cast. */
function rowPlaceholders(rowIndex: number, cols: number, jsonbLastCol = false): string {
  const base = rowIndex * cols;
  const parts: string[] = [];
  for (let c = 1; c <= cols; c++) {
    parts.push(`$${base + c}${jsonbLastCol && c === cols ? "::jsonb" : ""}`);
  }
  return `(${parts.join(",")})`;
}

async function bulkEnsureWindows(client: import("pg").PoolClient, specs: WindowSpec[]): Promise<void> {
  if (specs.length === 0) return;
  const values: unknown[] = [];
  const rows = specs.map((s, i) => {
    values.push(s.windowKey, s.customerId, s.metric, s.windowOpen, s.windowClose);
    return rowPlaceholders(i, 5);
  });
  await client.query(
    `INSERT INTO billing_window (window_key, customer_id, metric, window_open_ms, window_close_ms)
     VALUES ${rows.join(",")} ON CONFLICT (window_key) DO NOTHING`,
    values,
  );
}

async function bulkInsertEvents(client: import("pg").PoolClient, items: IngestItem[]): Promise<void> {
  if (items.length === 0) return;
  const values: unknown[] = [];
  const rows = items.map((it, i) => {
    values.push(
      it.ev.eventId,
      it.ev.customerId,
      it.ev.metric,
      formatMicros(it.micros),
      it.micros.toString(),
      it.ev.eventTime,
      it.ingestTimeMs,
      JSON.stringify(it.ev.payload ?? {}),
    );
    return rowPlaceholders(i, 8, true);
  });
  await client.query(
    `INSERT INTO event_log
       (event_id, customer_id, metric, quantity, quantity_micros, event_time_ms, ingest_time_ms, payload)
     VALUES ${rows.join(",")} ON CONFLICT (event_id) DO NOTHING`,
    values,
  );
}

async function bulkInsertCorrections(client: import("pg").PoolClient, corrections: CorrectionRow[]): Promise<void> {
  if (corrections.length === 0) return;
  const values: unknown[] = [];
  const rows = corrections.map((c, i) => {
    values.push(
      uuidv7(),
      c.windowKey,
      c.eventId,
      c.customerId,
      c.metric,
      formatMicros(c.micros),
      c.micros.toString(),
      c.eventTimeMs,
      c.ingestTimeMs,
      c.reason,
    );
    return rowPlaceholders(i, 10);
  });
  await client.query(
    `INSERT INTO correction_epoch
       (correction_id, window_key, event_id, customer_id, metric, quantity, quantity_micros, event_time_ms, quarantined_at_ms, reason)
     VALUES ${rows.join(",")} ON CONFLICT (event_id) DO NOTHING`,
    values,
  );
}
