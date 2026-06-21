import { describe, expect, it } from "vitest";

import { MemoryMeteringEngine } from "@/lib/engine";
import { AuroraMeteringEngine } from "@/lib/engine/aurora";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "@/harness/generator";
import { runInvariantSuite } from "./shared/invariant-suite";

const writerUrl = process.env.AURORA_WRITER_URL;
const windowMs = 10_000;
const latenessGraceMs = 2000;

if (writerUrl) {
  const wUrl: string = writerUrl;
  const rUrl: string = process.env.AURORA_READER_URL ?? writerUrl;

  // The IDENTICAL invariant suite, now executed against real Aurora.
  runInvariantSuite({
    label: "aurora",
    windowMs,
    latenessGraceMs,
    makeEngine: async () => {
      const e = new AuroraMeteringEngine({ writerUrl: wUrl, readerUrl: rUrl, latenessGraceMs, windowMs });
      await e.init();
      await e.reset();
      return e;
    },
  });

  describe("cross-backend parity (memory vs aurora)", () => {
    it("produces byte-identical billed totals for the same seed", async () => {
      const scenario = buildScenario({ seed: 2026, windowMs });
      const keys = scenarioWindowKeys(scenario);

      const mem = new MemoryMeteringEngine({ latenessGraceMs, windowMs });
      await mem.reset();
      await mem.ingest(arrivalOrder(scenario, 1));
      await mem.sealDueWindows();

      const aur = new AuroraMeteringEngine({ writerUrl: wUrl, readerUrl: rUrl, latenessGraceMs, windowMs });
      await aur.init();
      await aur.reset();
      await aur.ingest(arrivalOrder(scenario, 2)); // different arrival order on purpose
      await aur.sealDueWindows();

      for (const k of keys) {
        const m = await mem.windowTotal(k);
        const a = await aur.windowTotal(k);
        expect(a.billedTotalMicros).toBe(m.billedTotalMicros);
        expect(a.billedTotal).toBe(m.billedTotal);
      }

      await mem.close();
      await aur.close();
    });
  });
} else {
  describe.skip("metering invariant — aurora (set AURORA_WRITER_URL to run)", () => {
    it("skipped: no database configured", () => {});
  });
}
