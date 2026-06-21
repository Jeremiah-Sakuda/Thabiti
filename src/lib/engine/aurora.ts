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
import { windowForEvent } from "./windowing";

export interface AuroraEngineOptions {
  writerUrl: string | undefined;
  readerUrl: string | undefined;
  latenessGraceMs: number;
  windowMs: number;
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
    this.writer = new Pool({ connectionString: opts.writerUrl, max: 10, ssl: sslFor(opts.writerUrl) });
    this.reader = new Pool({
      connectionString: opts.readerUrl ?? opts.writerUrl,
      max: 10,
      ssl: sslFor(opts.readerUrl ?? opts.writerUrl),
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
    const touched = new Map<string, { customerId: string; metric: string }>();

    const client = await this.writer.connect();
    try {
      await client.query("BEGIN");
      for (const raw of events) {
        const ev = validate(raw);
        const micros = parseMicros(ev.quantity);
        const quantityStr = formatMicros(micros);
        const ingestTimeMs = ev.ingestTime ?? Date.now();
        const spec = windowForEvent(ev.customerId, ev.metric, ev.eventTime, this.windowMs);

        const wr = await client.query<{ state: string }>(
          "SELECT state FROM billing_window WHERE window_key = $1",
          [spec.windowKey],
        );

        // Late-after-seal → quarantine into the correction epoch, never merged.
        if (wr.rows[0]?.state === "sealed") {
          await client.query(
            `INSERT INTO correction_epoch
               (correction_id, window_key, event_id, customer_id, metric, quantity, quantity_micros, event_time_ms, quarantined_at_ms, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'late_after_seal')
             ON CONFLICT (event_id) DO NOTHING`,
            [uuidv7(), spec.windowKey, ev.eventId, ev.customerId, ev.metric, quantityStr, micros.toString(), ev.eventTime, ingestTimeMs],
          );
          quarantined++;
          dispositions.push({ eventId: ev.eventId, disposition: "quarantined", windowKey: spec.windowKey });
          continue;
        }

        // Materialize the (open) window, then append idempotently.
        await client.query(
          `INSERT INTO billing_window (window_key, customer_id, metric, window_open_ms, window_close_ms)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (window_key) DO NOTHING`,
          [spec.windowKey, spec.customerId, spec.metric, spec.windowOpen, spec.windowClose],
        );
        const ins = await client.query(
          `INSERT INTO event_log
             (event_id, customer_id, metric, quantity, quantity_micros, event_time_ms, ingest_time_ms, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [ev.eventId, ev.customerId, ev.metric, quantityStr, micros.toString(), ev.eventTime, ingestTimeMs, JSON.stringify(ev.payload ?? {})],
        );

        if (ins.rowCount === 1) {
          accepted++;
          dispositions.push({ eventId: ev.eventId, disposition: "accepted" });
          touched.set(`${ev.customerId}:${ev.metric}`, { customerId: ev.customerId, metric: ev.metric });
        } else {
          deduped++;
          dispositions.push({ eventId: ev.eventId, disposition: "deduped" });
        }
      }

      // Advance watermarks for touched streams (recomputed from the log).
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
    // Heavy aggregation + metadata read both run on the READER endpoint.
    const meta = await this.reader.query<{ state: string; sealed_watermark_ms: string | null }>(
      "SELECT state, sealed_watermark_ms FROM billing_window WHERE window_key = $1",
      [windowKey],
    );
    if (meta.rows.length === 0) {
      return { windowKey, billedTotal: formatMicros(0n), billedTotalMicros: "0", sealed: false, sealedWatermark: null, eventCount: 0 };
    }
    const agg = await this.reader.query<{ billed_total_micros: string; event_count: number }>(AGGREGATE_SQL, [windowKey]);
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

  async close(): Promise<void> {
    await Promise.all([this.writer.end(), this.reader.end()]);
  }
}

function sslFor(url: string | undefined): false | { rejectUnauthorized: boolean } {
  // Aurora requires TLS. For the demo we accept the RDS-managed cert; production
  // should pin the RDS CA bundle (see docs/AURORA_SETUP.md).
  if (url && /sslmode=(require|verify-ca|verify-full)/.test(url)) {
    return { rejectUnauthorized: false };
  }
  return false;
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
