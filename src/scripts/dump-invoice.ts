/**
 * Produce a full-invoice audit bundle from the configured backend, for the
 * standalone verifier:
 *
 *   THABITI_BACKEND=aurora npm run invoice:dump > invoice.json
 *   npm run verify -- invoice.json
 *
 * Resets, ingests the seeded hostile scenario, seals every due window, then emits
 * { windows: [ {receipt, leaves}, ... ] } for every sealed window. On the aurora
 * backend this runs against the live cluster, so the verifier reproduces the
 * live-Aurora billed total + roots.
 */

import { getConfig } from "../lib/config";
import { createEngine } from "../lib/engine";
import { arrivalOrder, buildScenario } from "../harness/generator";
import { loadEnv } from "./_env";

loadEnv();

async function main(): Promise<void> {
  const cfg = getConfig();
  const seed = Number(process.env.SEED ?? 2026);
  const engine = await createEngine(cfg);
  await engine.reset();

  const scenario = buildScenario({ seed, windowMs: cfg.windowMs });
  await engine.ingest(arrivalOrder(scenario, seed));
  await engine.sealDueWindows();

  const windows = await engine.windows();
  const bundles = [];
  for (const w of windows) {
    if (w.state !== "sealed") continue;
    const bundle = await engine.receiptBundle(w.windowKey);
    if (bundle) bundles.push(bundle);
  }
  await engine.close();

  process.stdout.write(JSON.stringify({ backend: engine.backend, seed, windows: bundles }, null, 2) + "\n");
  console.error(`dumped ${bundles.length} sealed-window receipts (backend=${engine.backend}, seed=${seed})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
