import type { BillingWindow, LoggedEvent } from "./types";

/**
 * The canonical total order and aggregation rule — the single most important
 * piece of logic in the project. The memory engine computes the billed total
 * exactly this way; the Aurora engine computes the equivalent in SQL (see
 * src/lib/sql/aggregate.sql). They MUST agree byte-for-byte.
 *
 *   TOTAL ORDER:  (event_time ASC, event_id ASC)
 *
 * event_id is a unique UUIDv7, so (event_time, event_id) is a *total* order — no
 * ties, no ambiguity. The billed total is the running sum's final value under
 * that order. With exact BigInt micro-units the scalar sum is already
 * order-independent; computing it as a running total under an explicit total
 * order is what makes the determinism property visible and what extends, without
 * changing the proof, to order-sensitive aggregates (running balances,
 * last-write semantics, tiered-rate boundaries). The total order is the
 * invariant; the scalar sum is a special case of it.
 */

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
 * Deterministic billed total for one window over the log.
 *
 * Mirrors aggregate.sql exactly:
 *   1. scope to the window's (customer, metric) and [open, close) event-time band
 *   2. if sealed, admit nothing past the sealed watermark
 *   3. order by the total order (event_time, event_id)
 *   4. running SUM over micro-units; the total is the final running value
 */
export function aggregateBilledTotal(
  log: Iterable<LoggedEvent>,
  window: BillingWindow,
): AggregateResult {
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

  // Running total under the total order; the billed total is the last value.
  let running = 0n;
  for (const e of windowed) running += e.quantityMicros;

  return { micros: running, eventCount: windowed.length };
}
