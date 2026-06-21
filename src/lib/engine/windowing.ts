/**
 * Window derivation. A billing window is a fixed-duration bucket of event-time,
 * aligned to the epoch, identified by a deterministic key. Both engines must use
 * the identical scheme so a given event always maps to the same window — that is
 * a precondition for cross-backend total equality.
 *
 * Production would swap fixed-duration buckets for calendar months; the key
 * derivation is the only thing that changes, and it stays a pure function of
 * (customerId, metric, event_time).
 */

export interface WindowSpec {
  windowKey: string;
  customerId: string;
  metric: string;
  windowOpen: number; // inclusive, epoch ms
  windowClose: number; // exclusive, epoch ms
}

export function windowStartFor(eventTime: number, windowMs: number): number {
  return Math.floor(eventTime / windowMs) * windowMs;
}

export function windowForEvent(
  customerId: string,
  metric: string,
  eventTime: number,
  windowMs: number,
): WindowSpec {
  const open = windowStartFor(eventTime, windowMs);
  return {
    windowKey: `${customerId}:${metric}:${open}`,
    customerId,
    metric,
    windowOpen: open,
    windowClose: open + windowMs,
  };
}
