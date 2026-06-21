import { getConfig, type ThabitiConfig } from "@/lib/config";
import { MemoryMeteringEngine } from "@/lib/engine";
import { windowForEvent } from "@/lib/engine";
import type { UsageEvent } from "@/lib/engine/types";
import { uuidv7 } from "@/lib/uuidv7";
import { arrivalOrder, buildScenario, scenarioWindowKeys, type Scenario } from "@/harness/generator";
import { jsonError, requireApiKey } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RunResult {
  order: number;
  delivered: number;
  grandTotal: string;
  totals: Record<string, string>;
}

/**
 * Side-by-side replay proof for Beat 3: replay the same seeded set in N hostile
 * arrival orders and return each run's per-window totals + grand total. It runs
 * on the CONFIGURED backend so the deployed proof exercises the real engine:
 *  - memory  → isolated fresh in-process engines per order.
 *  - aurora  → the real deterministic SQL, in an isolated customer namespace
 *    (remapped UUIDs) that is scoped-deleted afterwards, so the live timeline is
 *    untouched. Determinism is then demonstrated by Aurora, not merely asserted.
 */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireApiKey(req);
  if (unauthorized) return unauthorized;
  try {
    const body = (await req.json().catch(() => ({}))) as { seed?: number; orders?: number };
    const cfg = getConfig();
    const seed = body.seed ?? 2026;
    const orders = Math.min(Math.max(body.orders ?? 3, 2), 6);
    const scenario = buildScenario({ seed, windowMs: cfg.windowMs });

    const resolved =
      cfg.backend === "aurora"
        ? await replayOnAurora(cfg, scenario, seed, orders)
        : await replayOnMemory(cfg, scenario, seed, orders);

    const allEqual = resolved.every((r) => r.grandTotal === resolved[0]!.grandTotal);
    return Response.json({
      backend: cfg.backend,
      seed,
      orders,
      allEqual,
      grandTotal: resolved[0]!.grandTotal,
      runs: resolved,
    });
  } catch (e) {
    return jsonError(e);
  }
}

/** Memory backend: a fresh, isolated engine per arrival order. */
async function replayOnMemory(
  cfg: ThabitiConfig,
  scenario: Scenario,
  seed: number,
  orders: number,
): Promise<RunResult[]> {
  const keys = scenarioWindowKeys(scenario);
  const runs: RunResult[] = [];
  for (let order = 1; order <= orders; order++) {
    const engine = new MemoryMeteringEngine({ latenessGraceMs: cfg.latenessGraceMs, windowMs: cfg.windowMs });
    const arrival = arrivalOrder(scenario, seed * 100 + order);
    await engine.ingest(arrival);
    await engine.sealDueWindows();
    runs.push(await summarize(order, arrival.length, keys, (k) => engine.windowTotal(k)));
    await engine.close();
  }
  return runs;
}

/**
 * Aurora backend: run each order through the real engine on an isolated, remapped
 * customer namespace, then scoped-delete it. Exercises the deterministic SQL.
 */
async function replayOnAurora(
  cfg: ThabitiConfig,
  scenario: Scenario,
  seed: number,
  orders: number,
): Promise<RunResult[]> {
  const { AuroraMeteringEngine } = await import("@/lib/engine/aurora");
  const engine = new AuroraMeteringEngine({
    writerUrl: cfg.aurora.writerUrl,
    readerUrl: cfg.aurora.readerUrl,
    latenessGraceMs: cfg.latenessGraceMs,
    windowMs: cfg.windowMs,
    caCert: cfg.aurora.caCert,
  });
  await engine.init();

  const allCustomers: string[] = [];
  const runs: RunResult[] = [];
  try {
    for (let order = 1; order <= orders; order++) {
      // Remap to fresh customer UUIDs so this order never collides with live data.
      const remap = new Map<string, string>();
      const remapped: UsageEvent[] = scenario.events.map((e) => {
        let c = remap.get(e.customerId);
        if (!c) {
          c = uuidv7();
          remap.set(e.customerId, c);
          allCustomers.push(c);
        }
        return { ...e, customerId: c };
      });
      const pseudo: Scenario = { ...scenario, events: remapped };
      const arrival = arrivalOrder(pseudo, seed * 100 + order);
      await engine.ingest(arrival);
      await engine.sealDueWindows();

      const keys = [
        ...new Set(remapped.map((e) => windowForEvent(e.customerId, e.metric, e.eventTime, cfg.windowMs).windowKey)),
      ].sort();
      runs.push(await summarize(order, arrival.length, keys, (k) => engine.windowTotal(k)));
    }
  } finally {
    await engine.purgeCustomers(allCustomers).catch(() => {});
    await engine.close();
  }
  return runs;
}

async function summarize(
  order: number,
  delivered: number,
  keys: string[],
  totalFor: (k: string) => Promise<{ billedTotal: string; billedTotalMicros: string }>,
): Promise<RunResult> {
  const totals: Record<string, string> = {};
  let grand = 0n;
  for (const k of keys) {
    const t = await totalFor(k);
    totals[k] = t.billedTotal;
    grand += BigInt(t.billedTotalMicros);
  }
  return { order, delivered, grandTotal: formatGrand(grand), totals };
}

function formatGrand(micros: bigint): string {
  const neg = micros < 0n;
  const abs = (neg ? -micros : micros).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -6)}.${abs.slice(-6)}`;
}
