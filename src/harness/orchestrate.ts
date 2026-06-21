/** Shared orchestration helpers for the chaos harness (run + crash). */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { formatMicros, parseMicros } from "../lib/decimal";
import { MemoryMeteringEngine } from "../lib/engine/memory";
import type { ThabitiConfig } from "../lib/config";
import { buildScenario, type Scenario } from "./generator";
import { BASE_URL, api, ingestedEventCount } from "./client";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function banner(n: number, title: string): void {
  console.log("\n" + c.bold(c.cyan(`━━━ BEAT ${n} ━━━ ${title}`)));
}

export function narrate(s: string): void {
  console.log(c.dim("  » " + s));
}

/** Wait for the dev server to answer, with a clear message if it never does. */
export async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await api.acu();
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Thabiti server not reachable at ${BASE_URL}. Start it first: \`npm run dev\` (or set THABITI_BASE_URL).`,
        );
      }
      await sleep(300);
    }
  }
}

/**
 * Spawn a kill-able ingester child process in its OWN process group (detached),
 * so a hard kill takes down the whole tsx→node chain — not just a wrapper.
 */
export function spawnIngester(opts: {
  seed: number;
  order: number;
  chunk?: number;
  delayMs?: number;
  label?: string;
}): ChildProcess {
  const script = fileURLToPath(new URL("./ingester.ts", import.meta.url));
  const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
  const child = spawn(tsxBin, [script], {
    detached: true, // new process group: enables a real group-wide SIGKILL
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      SEED: String(opts.seed),
      ORDER: String(opts.order),
      CHUNK: String(opts.chunk ?? 40),
      DELAY_MS: String(opts.delayMs ?? 55),
      INGESTER_LABEL: opts.label ?? "ingester",
    },
  });
  return child;
}

/** Real hard kill (kill -9) of the entire ingester process group. */
export function killHard(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL"); // negative pid → whole group
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
}

/** Poll until the server has admitted at least `target` events (mid-flood gate). */
export async function waitForIngested(target: number, timeoutMs = 30_000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const n = await ingestedEventCount();
    if (n >= target) return n;
    if (Date.now() - start > timeoutMs) return n;
    await sleep(120);
  }
}

/**
 * The deterministic projection: the billed grand total the full seeded set MUST
 * produce, computed in-process (seal-at-end). The server must converge to this.
 */
export function projectGrandTotal(scenario: Scenario, cfg: ThabitiConfig): Promise<string> {
  return (async () => {
    const engine = new MemoryMeteringEngine({
      latenessGraceMs: cfg.latenessGraceMs,
      windowMs: cfg.windowMs,
    });
    await engine.ingest(scenario.events);
    await engine.sealDueWindows();
    const windows = await engine.windows();
    let g = 0n;
    for (const w of windows) {
      g += parseMicros((await engine.windowTotal(w.windowKey)).billedTotal);
    }
    await engine.close();
    return formatMicros(g);
  })();
}

export { buildScenario };
