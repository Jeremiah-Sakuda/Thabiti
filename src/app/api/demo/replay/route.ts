import { getConfig } from "@/lib/config";
import { MemoryMeteringEngine } from "@/lib/engine";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "@/harness/generator";
import { jsonError, requireApiKey } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Side-by-side replay proof for Beat 3: replay the same seeded set in N hostile
 * arrival orders and return each run's per-window totals + grand total. Runs in
 * isolated transient engines so it never disturbs the live timeline. The
 * deterministic rule is backend-agnostic (memory ≡ aurora, parity-tested), so
 * this is computed in-process for an instant, repeatable proof.
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
    const keys = scenarioWindowKeys(scenario);

    const runs: { order: number; delivered: number; grandTotal: string; totals: Record<string, string> }[] = [];
    for (let order = 1; order <= orders; order++) {
      const engine = new MemoryMeteringEngine({
        latenessGraceMs: cfg.latenessGraceMs,
        windowMs: cfg.windowMs,
      });
      const arrival = arrivalOrder(scenario, seed * 100 + order);
      await engine.ingest(arrival);
      await engine.sealDueWindows();

      const totals: Record<string, string> = {};
      let grand = 0n;
      for (const k of keys) {
        const t = await engine.windowTotal(k);
        totals[k] = t.billedTotal;
        grand += BigInt(t.billedTotalMicros);
      }
      runs.push({
        order,
        delivered: arrival.length,
        grandTotal: formatGrand(grand),
        totals,
      });
      await engine.close();
    }

    const allEqual = runs.every((r) => r.grandTotal === runs[0]!.grandTotal);
    return Response.json({ seed, orders, allEqual, grandTotal: runs[0]!.grandTotal, runs });
  } catch (e) {
    return jsonError(e);
  }
}

function formatGrand(micros: bigint): string {
  const neg = micros < 0n;
  const abs = (neg ? -micros : micros).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -6)}.${abs.slice(-6)}`;
}
