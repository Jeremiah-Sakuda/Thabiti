/**
 * Domain types for the append-only metering log and its projections.
 *
 * Money-bearing quantities live as BigInt micro-units internally (see decimal.ts)
 * so totals are exact and order-independent. API DTOs serialize them as strings.
 */

export type Backend = "memory" | "aurora";

/** An event as submitted by a client to the append-only log (pre-ingest). */
export interface UsageEvent {
  /** Client-generated UUIDv7. Dedup key and total-order tiebreaker. */
  eventId: string;
  customerId: string;
  metric: string;
  /** Metered amount. Number or exact decimal string; parsed to micro-units. */
  quantity: number | string;
  /** Business/event time (epoch ms): when usage happened. May be skewed/late. */
  eventTime: number;
  /** Processing time (epoch ms): when received. Server-assigned if omitted. */
  ingestTime?: number;
  payload?: Record<string, unknown>;
}

/** A row that has been admitted into the append-only log. */
export interface LoggedEvent {
  eventId: string;
  customerId: string;
  metric: string;
  quantityMicros: bigint;
  eventTime: number;
  ingestTime: number;
  payload: Record<string, unknown>;
}

export type Disposition = "accepted" | "deduped" | "quarantined";

export interface EventDisposition {
  eventId: string;
  disposition: Disposition;
  /** For quarantined events: the sealed window key the event tried to enter. */
  windowKey?: string;
}

export interface IngestResult {
  accepted: number;
  deduped: number;
  quarantined: number;
  dispositions: EventDisposition[];
}

export type WindowState = "open" | "sealed";

export interface BillingWindow {
  windowKey: string;
  customerId: string;
  metric: string;
  windowOpen: number; // epoch ms, inclusive
  windowClose: number; // epoch ms, exclusive
  state: WindowState;
  sealedAt: number | null; // processing time of seal
  sealedWatermark: number | null; // watermark at seal
}

export interface SealResult {
  newlySealed: string[];
  windows: BillingWindow[];
}

export interface WindowTotal {
  windowKey: string;
  /** Canonical decimal string, e.g. "123456.000000". Compared byte-for-byte. */
  billedTotal: string;
  /** The same total as raw micro-units (BigInt rendered as a string). */
  billedTotalMicros: string;
  sealed: boolean;
  sealedWatermark: number | null;
  /** Number of admitted events that participate in the total. */
  eventCount: number;
  /** How the metric is billed: "counter" (sum) or "gauge" (last-write-wins). */
  mode: "counter" | "gauge";
}

export interface CorrectionRecord {
  correctionId: string;
  windowKey: string;
  eventId: string;
  customerId: string;
  metric: string;
  quantity: string; // canonical decimal string
  eventTime: number;
  quarantinedAt: number;
  reason: string;
}

export interface WatermarkState {
  customerId: string;
  metric: string;
  watermark: number; // epoch ms
  latenessGraceMs: number;
}

export interface WindowFilter {
  customerId?: string;
  metric?: string;
}

export interface IngestOptions {
  /**
   * Seal windows whose close the watermark has passed at the end of this call.
   * Off by default: the determinism-critical paths ingest the full set and seal
   * once at the end, so window membership is a pure function of the event SET.
   * The live flood turns this on for visual auto-sealing.
   */
  autoSeal?: boolean;
}
