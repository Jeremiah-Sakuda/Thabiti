import type { BillingWindow, LoggedEvent } from "./types";

/**
 * The canonical total order and aggregation rules — the single most important
 * piece of logic in the project. The memory engine computes the billed value
 * exactly this way; the Aurora engine computes the equivalent in SQL (see
 * src/lib/sql/aggregate.sql and aggregate-gauge.sql). They MUST agree byte-for-byte.
 *
 *   TOTAL ORDER:  (event_time ASC, event_id ASC)
 *
 * event_id is a unique UUIDv7, so (event_time, event_id) is a *total* order — no
 * ties, no ambiguity. Two aggregation modes are shipped over that order:
 *
 *  - counter (SUM)   — exact bigint running total. Order-independent in value, but
 *    computed under the total order so the running-aggregate form is uniform.
 *  - gauge  (last-write-wins) — the value of the row with the greatest
 *    (event_time, event_id). Here the total order is strictly LOAD-BEARING: the
 *    event_id tiebreaker is what makes the "latest" value deterministic when two
 *    events share an event_time. Drop the tiebreaker and the billed value becomes
 *    arrival-order-dependent (proved by tests/shared/invariant-suite.ts).
 */

export type AggregationMode = "counter" | "gauge";

/** Metrics billed as gauges (latest value), not counters (sum). */
const GAUGE_METRICS = new Set(["active_seats", "plan_tier", "concurrent_connections"]);

export function aggregationMode(metric: string): AggregationMode {
  return GAUGE_METRICS.has(metric) || metric.endsWith("_gauge") ? "gauge" : "counter";
}

/** Strict total-order comparator over the append-only log. */
export function compareTotalOrder(a: LoggedEvent, b: LoggedEvent): number {
  if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
  // event_id is unique, so this branch fully disambiguates — the order is total.
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

export interface AggregateResult {
  micros: bigint;
  eventCount: number;
}

/**
 * Scope the log to one window and return its events in total order.
 *   1. scope to the window's (customer, metric) and [open, close) event-time band
 *   2. if sealed, admit nothing past the sealed watermark
 *   3. sort by the total order (event_time, event_id)
 */
function collectWindowed(log: Iterable<LoggedEvent>, window: BillingWindow): LoggedEvent[] {
  const windowed: LoggedEvent[] = [];
  for (const e of log) {
    if (e.customerId !== window.customerId) continue;
    if (e.metric !== window.metric) continue;
    if (e.eventTime < window.windowOpen) continue;
    if (e.eventTime >= window.windowClose) continue;
    if (
      window.state === "sealed" &&
      window.sealedWatermark !== null &&
      e.eventTime > window.sealedWatermark
    ) {
      // Nothing past the seal participates.
      continue;
    }
    windowed.push(e);
  }
  windowed.sort(compareTotalOrder);
  return windowed;
}

/** Counter total — running SUM over micro-units; mirrors aggregate.sql. */
export function aggregateBilledTotal(
  log: Iterable<LoggedEvent>,
  window: BillingWindow,
): AggregateResult {
  const windowed = collectWindowed(log, window);
  let running = 0n;
  for (const e of windowed) running += e.quantityMicros;
  return { micros: running, eventCount: windowed.length };
}

/**
 * Gauge value — last-write-wins by the total order; mirrors aggregate-gauge.sql.
 * The billed value is the quantity of the greatest (event_time, event_id) row, so
 * the event_id tiebreaker is required for determinism, not decoration.
 */
export function aggregateGauge(
  log: Iterable<LoggedEvent>,
  window: BillingWindow,
): AggregateResult {
  const windowed = collectWindowed(log, window);
  if (windowed.length === 0) return { micros: 0n, eventCount: 0 };
  const last = windowed[windowed.length - 1]!; // greatest under the total order
  return { micros: last.quantityMicros, eventCount: windowed.length };
}

/** Aggregate a window by its metric's mode. */
export function aggregateForMode(
  log: Iterable<LoggedEvent>,
  window: BillingWindow,
  mode: AggregationMode,
): AggregateResult {
  return mode === "gauge" ? aggregateGauge(log, window) : aggregateBilledTotal(log, window);
}
