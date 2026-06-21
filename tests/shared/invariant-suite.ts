import { beforeEach, describe, expect, it } from "vitest";

import { formatMicros } from "@/lib/decimal";
import type { MeteringEngine } from "@/lib/engine";
import { windowForEvent } from "@/lib/engine";
import type { UsageEvent } from "@/lib/engine/types";
import {
  arrivalOrder,
  buildScenario,
  expectedWindowTotals,
  scenarioWindowKeys,
} from "@/harness/generator";

export interface SuiteContext {
  label: string;
  windowMs: number;
  latenessGraceMs: number;
  /** Returns a FRESH, reset engine (clean state) on every call. */
  makeEngine: () => Promise<MeteringEngine>;
}

/** Collect billed totals (canonical strings) for a set of window keys. */
async function totalsFor(engine: MeteringEngine, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of keys) {
    const t = await engine.windowTotal(key);
    out.set(key, t.billedTotal);
  }
  return out;
}

function alignedBase(windowMs: number): number {
  return Math.floor(1_750_000_000_000 / windowMs) * windowMs;
}

/**
 * The invariant spec. Every backend runs this identical suite; for any seed they
 * must produce the identical billed total. These tests ARE the contract.
 */
export function runInvariantSuite(ctx: SuiteContext): void {
  describe(`metering invariant — ${ctx.label}`, () => {
    let engine: MeteringEngine;

    beforeEach(async () => {
      engine = await ctx.makeEngine();
    });

    it("replay-order invariance: identical billed total across N arrival orders", async () => {
      const scenario = buildScenario({ seed: 42, windowMs: ctx.windowMs });
      const keys = scenarioWindowKeys(scenario);
      const oracle = expectedWindowTotals(scenario);

      const runs: Map<string, string>[] = [];
      for (let order = 1; order <= 5; order++) {
        const e = await ctx.makeEngine();
        const arrival = arrivalOrder(scenario, order); // out-of-order + duplicates
        const res = await e.ingest(arrival);
        // Dedup is plumbing: every unique event admitted exactly once.
        expect(res.accepted).toBe(scenario.events.length);
        expect(res.deduped).toBe(arrival.length - scenario.events.length);
        await e.sealDueWindows();
        runs.push(await totalsFor(e, keys));
        await e.close();
      }

      // Every run equals run #1 — byte-for-byte, regardless of arrival order.
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i]).toEqual(runs[0]);
      }
      // And the deterministic total equals the independent oracle (it is correct,
      // not merely stable).
      for (const key of keys) {
        expect(runs[0]!.get(key)).toBe(formatMicros(oracle.get(key) ?? 0n));
      }
    });

    it("sealed-window rejection: a late event cannot move a sealed total", async () => {
      const D = ctx.windowMs;
      const G = ctx.latenessGraceMs;
      const base = alignedBase(D);
      const customerId = "00000000-0000-7000-8000-000000000001";
      const metric = "api_calls";
      const w0 = windowForEvent(customerId, metric, base, D).windowKey;

      const onTime: UsageEvent[] = [
        { eventId: "00000000-0000-7000-8000-0000000000a1", customerId, metric, quantity: 100, eventTime: base + Math.floor(D * 0.1) },
        { eventId: "00000000-0000-7000-8000-0000000000a2", customerId, metric, quantity: 50, eventTime: base + Math.floor(D * 0.2) },
        // A later-window event drags the watermark past W0.close so W0 seals.
        { eventId: "00000000-0000-7000-8000-0000000000a3", customerId, metric, quantity: 999, eventTime: base + D + G + 1 },
      ];

      await engine.ingest(onTime);
      const sealRes = await engine.sealDueWindows();
      expect(sealRes.newlySealed).toContain(w0);

      const before = await engine.windowTotal(w0);
      expect(before.sealed).toBe(true);
      expect(before.billedTotal).toBe(formatMicros(150_000_000n)); // 100 + 50

      // A straggler whose event_time lands INSIDE the now-sealed W0.
      const straggler: UsageEvent = {
        eventId: "00000000-0000-7000-8000-0000000000ff",
        customerId,
        metric,
        quantity: 777,
        eventTime: base + Math.floor(D * 0.3),
      };
      const res = await engine.ingest([straggler]);

      expect(res.quarantined).toBe(1);
      expect(res.accepted).toBe(0);
      expect(res.dispositions[0]?.disposition).toBe("quarantined");

      const after = await engine.windowTotal(w0);
      expect(after.billedTotal).toBe(before.billedTotal); // the number did not move

      const corrections = await engine.corrections(w0);
      expect(corrections.map((c) => c.eventId)).toContain(straggler.eventId);
      expect(corrections[0]?.reason).toBe("late_after_seal");
    });

    it("crash-replay equivalence: re-ingesting the full log yields a bit-identical total", async () => {
      const scenario = buildScenario({ seed: 7, windowMs: ctx.windowMs });
      const keys = scenarioWindowKeys(scenario);

      // Pre-crash projection.
      const before = await ctx.makeEngine();
      await before.ingest(arrivalOrder(scenario, 11));
      await before.sealDueWindows();
      const t1 = await totalsFor(before, keys);
      await before.close();

      // "Crash": discard the projection. Restart from the append-only log by
      // re-ingesting the same set in a DIFFERENT order. Idempotent dedup +
      // deterministic aggregation ⇒ the total lands on the same value.
      const after = await ctx.makeEngine();
      await after.ingest(arrivalOrder(scenario, 99));
      await after.sealDueWindows();
      const t2 = await totalsFor(after, keys);
      await after.close();

      expect(t2).toEqual(t1);
    });

    it("idempotency contract: a conflicting re-delivery (same id, different payload) is detected, audited, and never moves the total", async () => {
      const D = ctx.windowMs;
      const base = alignedBase(D);
      const customerId = "00000000-0000-7000-8000-0000000000c1";
      const metric = "api_calls";
      const w = windowForEvent(customerId, metric, base, D).windowKey;
      const ev: UsageEvent = {
        eventId: "00000000-0000-7000-8000-0000000000e1",
        customerId,
        metric,
        quantity: 100,
        eventTime: base + 1,
      };

      await engine.ingest([ev]);
      const before = await engine.windowTotal(w);
      expect(before.billedTotal).toBe(formatMicros(100_000_000n));

      // Same id, DIFFERENT quantity — a contract violation, not a valid update.
      const res = await engine.ingest([{ ...ev, quantity: 999 }]);
      expect(res.accepted).toBe(0);
      expect(res.deduped).toBe(1); // not merged

      const after = await engine.windowTotal(w);
      expect(after.billedTotal).toBe(before.billedTotal); // first-admitted value is authoritative

      const corr = await engine.corrections(w);
      expect(corr.some((c) => c.eventId === ev.eventId && c.reason === "payload_conflict")).toBe(true);
    });

    it("audit fidelity: re-delivering an already-billed event after seal is a dedup, not a quarantine", async () => {
      const scenario = buildScenario({ seed: 8, windowMs: ctx.windowMs, windowCount: 3 });
      await engine.ingest(scenario.events); // all admitted (seal-at-end)
      await engine.sealDueWindows();

      const sealed = (await engine.windows()).find((w) => w.state === "sealed");
      expect(sealed).toBeDefined();
      const billed = scenario.events.find(
        (e) => windowForEvent(e.customerId, e.metric, e.eventTime, ctx.windowMs).windowKey === sealed!.windowKey,
      );
      expect(billed).toBeDefined();

      const corrBefore = (await engine.corrections(sealed!.windowKey)).length;
      const res = await engine.ingest([billed!]); // re-deliver an already-billed event into the now-sealed window

      expect(res.deduped).toBe(1); // already counted → a duplicate
      expect(res.quarantined).toBe(0); // NOT a late rewrite
      expect((await engine.corrections(sealed!.windowKey)).length).toBe(corrBefore); // no false-positive correction
    });

    it("idempotency: re-ingesting an already-sealed window's events leaves the total fixed", async () => {
      const scenario = buildScenario({ seed: 3, windowMs: ctx.windowMs, windowCount: 3 });
      const keys = scenarioWindowKeys(scenario);

      await engine.ingest(arrivalOrder(scenario, 5));
      await engine.sealDueWindows();
      const t1 = await totalsFor(engine, keys);

      // Replay the entire set again — every event is now either a dedup (open
      // windows) or a quarantine (sealed windows). The totals must not move.
      const res = await engine.ingest(scenario.events);
      expect(res.accepted).toBe(0);
      await engine.sealDueWindows();
      const t2 = await totalsFor(engine, keys);

      expect(t2).toEqual(t1);
    });
  });
}
