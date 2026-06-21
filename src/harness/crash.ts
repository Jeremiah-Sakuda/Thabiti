/**
 * Crash-replay equivalence proof (Beat 3).
 *
 * Floods the server via a child ingester, HARD-KILLS it mid-flood (real SIGKILL,
 * i.e. kill -9, with the PID shown), then restarts ingestion from the durable
 * append-only log. The recovered invoice lands bit-identical to the deterministic
 * projection — the number a crash cannot move. Requires a running server.
 */

import { getConfig } from "../lib/config";
import { loadEnv } from "../scripts/_env";
import { api, grandTotalMicros } from "./client";
import { formatMicros } from "../lib/decimal";
import {
  banner,
  buildScenario,
  c,
  killHard,
  narrate,
  projectGrandTotal,
  spawnIngester,
  waitForExit,
  waitForIngested,
  waitForServer,
} from "./orchestrate";

loadEnv();

async function main(): Promise<void> {
  const cfg = getConfig();
  const seed = Number(process.env.SEED ?? 2026);
  await waitForServer();
  await api.reset();

  const scenario = buildScenario({ seed, windowMs: cfg.windowMs });
  const projection = await projectGrandTotal(scenario, cfg);

  banner(3, "THE CRASH — hard-kill mid-invoice, recover bit-identical");
  narrate(`backend = ${c.bold((await api.state()).backend)}`);
  narrate(`deterministic projection for the full set = ${c.bold(projection)}`);

  // Flood, then kill mid-way.
  const killAt = Math.floor(scenario.events.length * 0.4);
  const child = spawnIngester({ seed, order: 1, chunk: 30, delayMs: 70, label: "ingester" });
  narrate(`ingester started (pid ${c.bold(String(child.pid))}); waiting to cross ${killAt} events…`);

  const reached = await waitForIngested(killAt);
  const partial = formatMicros(await grandTotalMicros());
  console.log(
    c.red(`\n  ✖ kill -9 ${child.pid}`) +
      c.dim(`   (server had admitted ${reached} events; partial invoice = ${partial})`),
  );
  killHard(child);

  // Restart: re-ingest the full set in a DIFFERENT order. Idempotent dedup +
  // deterministic aggregation ⇒ convergence to the projection.
  narrate("restarting ingester — resuming from the durable log (different order)…");
  const restart = spawnIngester({ seed, order: 2, chunk: 60, delayMs: 20, label: "ingester-restart" });
  await waitForExit(restart);

  await api.seal();
  const recovered = formatMicros(await grandTotalMicros());

  const ok = recovered === projection;
  console.log();
  narrate(`recovered invoice  = ${c.bold(recovered)}`);
  narrate(`projection         = ${c.bold(projection)}`);
  console.log(
    ok
      ? c.green(`\n  ✓ CRASH-REPLAY EQUIVALENCE: recovered total is bit-identical to the projection.`)
      : c.red(`\n  ✗ MISMATCH: ${recovered} ≠ ${projection}`),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
