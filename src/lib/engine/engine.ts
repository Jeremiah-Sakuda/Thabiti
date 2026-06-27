import type {
  BillingWindow,
  Backend,
  CorrectionRecord,
  IngestOptions,
  IngestResult,
  SealResult,
  UsageEvent,
  WatermarkState,
  WindowFilter,
  WindowTotal,
} from "./types";
import type { AuditBundle } from "./receipt";

/**
 * The metering contract. Two implementations — `memory` and `aurora` — are
 * selected by THABITI_BACKEND. They run the IDENTICAL invariant under the
 * IDENTICAL property tests: for any seed, both produce the same billed total.
 *
 * The load-bearing guarantee, enforced by every implementation:
 *   WATERMARK-BOUNDED TEMPORAL DETERMINISM — the billed total for a window is
 *   byte-identical across replays despite late/out-of-order/skewed events, and
 *   once a window is SEALED no later event can mutate it.
 */
export interface MeteringEngine {
  readonly backend: Backend;

  /**
   * Append events to the log. Idempotent on eventId (duplicates are absorbed).
   * Events whose event_time falls inside an already-sealed window are NOT merged;
   * they are routed to the correction epoch and reported as `quarantined`.
   * Advances per-stream watermarks from admitted events.
   */
  ingest(events: UsageEvent[], opts?: IngestOptions): Promise<IngestResult>;

  /**
   * Seal every open window whose close the stream watermark has passed. Sealing
   * records the sealed watermark and seal time in one transaction and is a pure
   * state transition — never a recomputation. Idempotent.
   */
  sealDueWindows(now?: number): Promise<SealResult>;

  /**
   * The deterministic billed total for a window: a single window-function
   * aggregation over the append-only log under the total order
   * (event_time, event_id), bounded by the sealed watermark.
   */
  windowTotal(windowKey: string): Promise<WindowTotal>;

  /** Quarantined late-after-seal events for a window (the audit view). */
  corrections(windowKey: string): Promise<CorrectionRecord[]>;

  /**
   * The customer-verifiable audit bundle for a SEALED window: the committed
   * Merkle receipt plus the ordered leaves, so anyone can independently
   * recompute the root and billed total. null if the window isn't sealed.
   */
  receiptBundle(windowKey: string): Promise<AuditBundle | null>;

  /** Current watermark for a stream, or null if the stream is unseen. */
  watermark(customerId: string, metric: string): Promise<WatermarkState | null>;

  /** All windows (optionally filtered) for the timeline UI. */
  windows(filter?: WindowFilter): Promise<BillingWindow[]>;

  /** Drop all state. Demo/test convenience. */
  reset(): Promise<void>;

  /** Release resources (connection pools, file handles). */
  close(): Promise<void>;
}
