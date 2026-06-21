import { getConfig } from "../lib/config";
import { createEngine } from "../lib/engine";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "../harness/generator";
import { loadEnv } from "./_env";

loadEnv();

/**
 * Live determinism proof against the configured backend (memory or aurora):
 * replay one seeded event set in three different hostile arrival orders and show
 * the billed totals are byte-identical. Exits non-zero on any mismatch.
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const scenario = buildScenario({ seed: 2026, windowMs: cfg.windowMs });
  const keys = scenarioWindowKeys(scenario);

  console.log(`backend = ${cfg.backend}`);
  console.log(`scenario: ${scenario.events.length} unique events across ${keys.length} windows\n`);

  const runs: { order: number; totals: Map<string, string> }[] = [];
  for (const order of [1, 2, 3]) {
    const engine = await createEngine(cfg);
    await engine.reset();
    const arrival = arrivalOrder(scenario, order);
    const res = await engine.ingest(arrival);
    await engine.sealDueWindows();
    const totals = new Map<string, string>();
    for (const k of keys) totals.set(k, (await engine.windowTotal(k)).billedTotal);
    runs.push({ order, totals });
    console.log(
      `order #${order}: delivered ${arrival.length} (accepted ${res.accepted}, deduped ${res.deduped}), ` +
        `Σ = ${sumTotals(totals)}`,
    );
    await engine.close();
  }

  const first = runs[0]!.totals;
  let ok = true;
  for (const run of runs.slice(1)) {
    for (const k of keys) {
      if (run.totals.get(k) !== first.get(k)) {
        ok = false;
        console.error(`MISMATCH at ${k}: order#${run.order}=${run.totals.get(k)} vs order#1=${first.get(k)}`);
      }
    }
  }

  console.log(ok ? "\n✓ byte-identical across all three arrival orders" : "\n✗ determinism violated");
  process.exit(ok ? 0 : 1);
}

function sumTotals(totals: Map<string, string>): string {
  let s = 0n;
  for (const v of totals.values()) s += BigInt(v.replace(".", ""));
  // re-insert the decimal point (6 places)
  const neg = s < 0n;
  const abs = (neg ? -s : s).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -6)}.${abs.slice(-6)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
