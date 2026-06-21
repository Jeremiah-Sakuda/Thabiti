/**
 * Seeded, reproducible generator for a hostile usage-event stream.
 *
 * From a single integer seed it produces a canonical set of unique events and,
 * on demand, adversarial *arrival orders* of that set: out-of-order delivery,
 * duplicate deliveries, and clock skew (ingest_time vs event_time). Because
 * everything derives from the seed, the same scenario reproduces byte-for-byte
 * across processes — which is what makes crash-replay equivalence testable.
 */

import { parseMicros } from "../lib/decimal";
import type { UsageEvent } from "../lib/engine/types";
import { windowForEvent } from "../lib/engine/windowing";
import { mulberry32, uuidv7, type Rng } from "../lib/uuidv7";

export interface ScenarioOptions {
  seed: number;
  /** Number of distinct customers (tenants). */
  customers?: number;
  /** Metric names. */
  metrics?: string[];
  /** Window size in event-time ms (must match engine config). */
  windowMs?: number;
  /** How many consecutive windows of event-time to span. */
  windowCount?: number;
  /** Events per (customer, metric) per window. */
  eventsPerStreamPerWindow?: number;
  /** Base event-time (epoch ms). */
  baseTime?: number;
  /** Quantities are integers in [1, maxQuantity]. */
  maxQuantity?: number;
  /** Max absolute clock skew applied to ingest_time vs event_time (ms). */
  skewMs?: number;
}

export type ResolvedScenarioOptions = Required<ScenarioOptions>;

export interface Scenario {
  options: ResolvedScenarioOptions;
  customers: string[];
  metrics: string[];
  /** Canonical, de-duplicated, source-of-truth event set. */
  events: UsageEvent[];
}

const DEFAULTS: Omit<ResolvedScenarioOptions, "seed"> = {
  customers: 3,
  metrics: ["api_calls", "tokens", "gb_egress"],
  windowMs: 10_000,
  windowCount: 4,
  eventsPerStreamPerWindow: 40,
  baseTime: 1_750_000_000_000, // fixed epoch base → reproducible windows
  maxQuantity: 1000,
  skewMs: 1500,
};

export function resolveOptions(opts: ScenarioOptions): ResolvedScenarioOptions {
  return { ...DEFAULTS, ...opts };
}

export function buildScenario(opts: ScenarioOptions): Scenario {
  const o = resolveOptions(opts);
  const rng = mulberry32(o.seed);

  const customers: string[] = [];
  for (let i = 0; i < o.customers; i++) customers.push(uuidv7(o.baseTime + i, rng));
  const metrics = o.metrics.slice();

  const events: UsageEvent[] = [];
  for (const customerId of customers) {
    for (const metric of metrics) {
      for (let w = 0; w < o.windowCount; w++) {
        const windowStart = o.baseTime + w * o.windowMs;
        for (let i = 0; i < o.eventsPerStreamPerWindow; i++) {
          const eventTime = windowStart + Math.floor(rng() * o.windowMs);
          const quantity = 1 + Math.floor(rng() * o.maxQuantity);
          const skew = Math.floor((rng() * 2 - 1) * o.skewMs);
          events.push({
            eventId: uuidv7(eventTime, rng),
            customerId,
            metric,
            quantity,
            eventTime,
            ingestTime: eventTime + skew, // clock skew: processing time wobbles
            payload: { window: w, source: "chaos-harness" },
          });
        }
      }
    }
  }

  return { options: o, customers, metrics, events };
}

/** Fisher–Yates shuffle with a seeded RNG (out-of-order delivery). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * Produce one adversarial arrival order of a scenario's events: shuffled
 * (out-of-order) and salted with duplicate deliveries. Deterministic in
 * (scenario seed, orderSeed). Duplicates are exact resends of the same event_id,
 * which the engine must absorb idempotently.
 */
export function arrivalOrder(
  scenario: Scenario,
  orderSeed: number,
  duplicateRate = 0.15,
): UsageEvent[] {
  const rng = mulberry32(orderSeed ^ 0x9e3779b9);
  const shuffled = shuffle(scenario.events, rng);
  const out: UsageEvent[] = [];
  for (const e of shuffled) {
    out.push(e);
    if (rng() < duplicateRate) out.push({ ...e }); // duplicate delivery
  }
  return shuffle(out, rng); // re-shuffle so duplicates aren't adjacent
}

/** Independent oracle: expected per-window total (micro-units) over the set. */
export function expectedWindowTotals(scenario: Scenario): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const e of scenario.events) {
    const spec = windowForEvent(e.customerId, e.metric, e.eventTime, scenario.options.windowMs);
    const micros = parseMicros(e.quantity);
    totals.set(spec.windowKey, (totals.get(spec.windowKey) ?? 0n) + micros);
  }
  return totals;
}

/** All distinct window keys present in a scenario, sorted. */
export function scenarioWindowKeys(scenario: Scenario): string[] {
  const keys = new Set<string>();
  for (const e of scenario.events) {
    keys.add(windowForEvent(e.customerId, e.metric, e.eventTime, scenario.options.windowMs).windowKey);
  }
  return [...keys].sort();
}
