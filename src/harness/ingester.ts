/**
 * Disposable ingester process. Floods the running server with a seeded, hostile
 * arrival order (out-of-order + duplicates), chunk by chunk. Designed to be
 * hard-killed (kill -9 / SIGKILL) mid-flood: it holds no irreplaceable state —
 * the append-only log lives in the server. On restart it simply re-sends the
 * full set; idempotent dedup absorbs whatever already landed.
 */

import { api } from "./client";
import { arrivalOrder, buildScenario } from "./generator";
import { loadEnv } from "../scripts/_env";

loadEnv();

const SEED = Number(process.env.SEED ?? 2026);
const ORDER = Number(process.env.ORDER ?? 1);
const CHUNK = Number(process.env.CHUNK ?? 40);
const DELAY_MS = Number(process.env.DELAY_MS ?? 55);
const LABEL = process.env.INGESTER_LABEL ?? "ingester";
const WINDOW_MS = Number(process.env.THABITI_WINDOW_MS ?? 10_000);

const tag = `[${LABEL} pid=${process.pid}]`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const scenario = buildScenario({ seed: SEED, windowMs: WINDOW_MS });
  const arrival = arrivalOrder(scenario, SEED * 100 + ORDER);
  console.log(`${tag} flooding ${arrival.length} deliveries (seed=${SEED}, order=${ORDER})`);

  let sent = 0;
  for (let i = 0; i < arrival.length; i += CHUNK) {
    const batch = arrival.slice(i, i + CHUNK);
    await api.ingest(batch);
    sent += batch.length;
    if ((i / CHUNK) % 5 === 0) {
      process.stdout.write(`\r${tag} sent ${sent}/${arrival.length}   `);
    }
    await sleep(DELAY_MS);
  }
  console.log(`\n${tag} done (${sent} deliveries sent)`);
}

main().catch((err) => {
  console.error(`${tag} error:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
