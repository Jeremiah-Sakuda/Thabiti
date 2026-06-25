import { describe, expect, it } from "vitest";

import { parseMicros } from "@/lib/decimal";
import { aggregateGauge, aggregateGaugeWeakened } from "@/lib/engine";
import type { BillingWindow, LoggedEvent } from "@/lib/engine/types";

/**
 * Proves the "Pull the Tiebreaker" demo is genuine: with the event_id tiebreaker
 * the gauge value is locked across every arrival permutation; without it (the
 * diagnostic weakened comparator) the value really flickers by arrival order —
 * the flicker comes from the weakened comparator over real permutations, not
 * from any randomness faking chaos.
 */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i]!, ...p]);
  }
  return out;
}

const customerId = "00000000-0000-7000-8000-000000000c01";
const metric = "active_seats";
const D = 10_000;
const base = Math.floor(1_750_000_000_000 / D) * D;
const tieTime = base + 8000;

const mk = (eventId: string, q: number, t: number): LoggedEvent => ({
  eventId,
  customerId,
  metric,
  quantityMicros: parseMicros(q),
  eventTime: t,
  ingestTime: t,
  payload: {},
});

const events = [
  mk("00000000-0000-7000-8000-00000000aa00", 999, base + 1000),
  mk("00000000-0000-7000-8000-00000000aaaa", 11, tieTime),
  mk("00000000-0000-7000-8000-00000000ffff", 22, tieTime),
];

const window: BillingWindow = {
  windowKey: `${customerId}:${metric}:${base}`,
  customerId,
  metric,
  windowOpen: base,
  windowClose: base + D,
  state: "open",
  sealedAt: null,
  sealedWatermark: null,
};

describe("gauge breaker — the total order is load-bearing", () => {
  const perms = permutations(events);

  it("WITH the event_id tiebreaker: locked across all 6 arrival orders", () => {
    const values = new Set(perms.map((p) => aggregateGauge(p, window).micros));
    expect(values.size).toBe(1);
    expect([...values][0]).toBe(22_000_000n); // greatest (event_time, event_id) wins
  });

  it("WITHOUT it (diagnostic): the billed value flickers by arrival order", () => {
    const values = new Set(perms.map((p) => aggregateGaugeWeakened(p, window).micros));
    expect(values.size).toBeGreaterThan(1); // genuinely a coin flip
    expect(values).toContain(22_000_000n);
    expect(values).toContain(11_000_000n);
  });
});
