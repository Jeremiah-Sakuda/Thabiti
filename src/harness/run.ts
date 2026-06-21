/**
 * The one-command hostile run — drives all four demo beats against a running
 * server, with a real process hard-kill mid-flood. Pairs with the UI, or stands
 * alone as a terminal-narrated proof. Requires `npm run dev` (any backend).
 */

import { getConfig } from "../lib/config";
import { loadEnv } from "../scripts/_env";
import { formatMicros, parseMicros, prettyMicros } from "../lib/decimal";
import { uuidv7 } from "../lib/uuidv7";
import type { UsageEvent } from "../lib/engine/types";
import { api, grandTotalMicros, type AcuView, type StateView } from "./client";
import {
  banner,
  buildScenario,
  c,
  killHard,
  narrate,
  projectGrandTotal,
  sleep,
  spawnIngester,
  waitForExit,
  waitForIngested,
  waitForServer,
} from "./orchestrate";

loadEnv();

function acuBar(acu: number, max: number): string {
  const width = 18;
  const filled = Math.round((acu / Math.max(max, 1)) * width);
  return "[" + "█".repeat(filled) + "·".repeat(Math.max(0, width - filled)) + "]";
}

function showAcu(a: AcuView): void {
  console.log(
    c.dim("    writer ") + c.cyan(acuBar(a.writerAcu, a.maxAcu)) + ` ${a.writerAcu.toFixed(2)} ACU` +
      c.dim("   reader ") + c.magenta(acuBar(a.readerAcu, a.maxAcu)) + ` ${a.readerAcu.toFixed(2)} ACU` +
      c.dim(`   cost $${a.costUsd.toFixed(6)}`),
  );
}

function sealedCount(s: StateView): number {
  return s.windows.filter((w) => w.state === "sealed").length;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const seed = Number(process.env.SEED ?? 2026);
  await waitForServer();
  await api.reset();

  const scenario = buildScenario({ seed, windowMs: cfg.windowMs });
  const projection = await projectGrandTotal(scenario, cfg);
  const backend = (await api.state()).backend;

  console.log(c.bold(`\nThabiti hostile run  ·  backend=${backend}  ·  seed=${seed}`));
  console.log(c.dim(`  ${scenario.events.length} unique events · window ${cfg.windowMs}ms · lateness grace ${cfg.latenessGraceMs}ms`));

  let s: StateView;

  // ── BEAT 1 ── the flood ────────────────────────────────────────────────────
  // Flood WITHOUT sealing: under a hostile full shuffle, sealing mid-flood would
  // (correctly) quarantine genuinely in-window events that arrive after their
  // window's watermark passes. The determinism proofs use seal-at-end, so the
  // billed total is a pure function of the event SET.
  banner(1, "THE FLOOD — duplicates, out-of-order, clock-skewed, late");
  const flood = spawnIngester({ seed, order: 1, chunk: 30, delayMs: 60, label: "ingester" });
  narrate(`ingester pid ${c.bold(String(flood.pid))} firing the firehose at the writer…`);
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    s = await api.state();
    const admitted = s.windows.reduce((n, w) => n + w.eventCount, 0);
    console.log(c.dim(`    admitted ${admitted} events`));
    showAcu(s.acu);
  }
  await waitForExit(flood); // let the full set land

  // ── BEAT 2 ── the seal + quarantine ─────────────────────────────────────────
  banner(2, "THE SEAL — a late event hits a sealed invoice and is quarantined");
  await api.seal(); // seal-at-end: every window the watermark has cleared
  s = await api.state();
  const grandAfterFlood = formatMicros(await grandTotalMicros());
  narrate(`${sealedCount(s)} windows SEALED · invoice = ${c.bold(grandAfterFlood)} (= projection ${projection})`);
  const sealedWindow = s.windows.find((w) => w.state === "sealed");
  if (sealedWindow) {
    const before = sealedWindow.billedTotal;
    const windowStart = Number(sealedWindow.windowKey.split(":").pop());
    const straggler: UsageEvent = {
      eventId: uuidv7(),
      customerId: sealedWindow.customerId,
      metric: sealedWindow.metric,
      quantity: 9999,
      eventTime: windowStart + 1, // inside the now-sealed window
      payload: { straggler: true },
    };
    const res = await api.ingest([straggler]);
    const after = (await api.windowTotal(sealedWindow.windowKey)).billedTotal;
    console.log(
      (res.quarantined === 1 ? c.yellow("    ⟶ QUARANTINED") : c.red("    ⟶ NOT quarantined?!")) +
        c.dim(` late +9999 into sealed window ${sealedWindow.windowKey.slice(-13)} · total ${before} → ${after} `) +
        (before === after ? c.green("(unchanged)") : c.red("(MOVED!)")),
    );
  }

  // ── BEAT 3 ── the crash + replay ────────────────────────────────────────────
  // Self-contained crash run on a clean slate (seal-at-end), so the recovered
  // invoice must equal the deterministic projection exactly.
  banner(3, "THE CRASH — kill -9 mid-flood, recover & replay bit-identical");
  await api.reset();
  const crashFlood = spawnIngester({ seed, order: 1, chunk: 30, delayMs: 70, label: "ingester" });
  const killAt = Math.floor(scenario.events.length * 0.4);
  const reached = await waitForIngested(killAt, 10_000);
  const partial = formatMicros(await grandTotalMicros());
  console.log(c.red(`    ✖ kill -9 ${crashFlood.pid}`) + c.dim(`  (admitted ${reached}; partial invoice ${partial})`));
  killHard(crashFlood);

  narrate("restarting ingester — resuming from the durable append-only log (different order)…");
  const restart = spawnIngester({ seed, order: 2, chunk: 80, delayMs: 10, label: "ingester-restart" });
  await waitForExit(restart);
  await api.seal();
  const recovered = formatMicros(await grandTotalMicros());
  console.log(
    (recovered === projection ? c.green("    ✓ recovered ") : c.red("    ✗ recovered ")) +
      c.bold(recovered) +
      c.dim(`  vs projection ${projection}`),
  );

  narrate("replaying the same set in 3 different arrival orders…");
  const replay = await api.replay(seed, 3);
  for (const r of replay.runs) {
    console.log(c.dim(`      order #${r.order}  delivered ${r.delivered}  ⟶  Σ `) + c.bold(r.grandTotal));
  }
  console.log(replay.allEqual ? c.green("    ✓ all three totals byte-identical") : c.red("    ✗ totals diverged"));

  // ── BEAT 4 ── the collapse + cost ───────────────────────────────────────────
  // Poll the lightweight ACU endpoint (no aggregation) so the reader can truly
  // fall idle — polling /api/state would itself keep the reader busy.
  banner(4, "THE COLLAPSE — ACU falls to ~0, the run's cost is settled");
  narrate("flood over; watching writer & reader capacity collapse…");
  let acu: AcuView = await api.acu();
  for (let i = 0; i < 12; i++) {
    await sleep(900);
    acu = await api.acu();
    showAcu(acu);
    if (acu.writerAcu < 0.05 && acu.readerAcu < 0.05) break;
  }
  console.log();
  narrate(`provably-correct invoice total = ${c.bold(prettyMicros(parseMicros(projection)))}`);
  narrate(`this run cost ${c.bold("$" + acu.costUsd.toFixed(6))} of Aurora compute (${acu.source}); idle spend → $0`);
  console.log(c.green("\n✓ four beats complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
