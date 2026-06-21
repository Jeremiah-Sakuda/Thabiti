import { markRunStart, recordIngest } from "@/lib/acu";
import { getConfig } from "@/lib/config";
import { getEngine } from "@/lib/engine";
import type { UsageEvent } from "@/lib/engine/types";
import { uuidv7 } from "@/lib/uuidv7";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "@/harness/generator";
import { jsonError } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drive a full seeded hostile run server-side (non-animated convenience / test
 * target): reset, flood with an out-of-order + duplicate arrival, seal, then fire
 * a late straggler into a sealed window to show it quarantined.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { seed?: number; includeStraggler?: boolean };
    const cfg = getConfig();
    const seed = body.seed ?? 2026;
    const engine = await getEngine();

    markRunStart();
    await engine.reset();

    const scenario = buildScenario({ seed, windowMs: cfg.windowMs });
    const arrival = arrivalOrder(scenario, seed);
    const ingestResult = await engine.ingest(arrival);
    recordIngest(arrival.length);

    const sealResult = await engine.sealDueWindows();

    // Late straggler into a sealed window → must be quarantined.
    let straggler: { eventId: string; quarantined: boolean } | null = null;
    if (body.includeStraggler !== false) {
      const windows = await engine.windows();
      const sealed = windows.find((w) => w.state === "sealed");
      if (sealed) {
        const ev: UsageEvent = {
          eventId: uuidv7(),
          customerId: sealed.customerId,
          metric: sealed.metric,
          quantity: 4242,
          eventTime: sealed.windowOpen + Math.floor((sealed.windowClose - sealed.windowOpen) / 2),
          payload: { straggler: true },
        };
        const res = await engine.ingest([ev]);
        straggler = { eventId: ev.eventId, quarantined: res.quarantined === 1 };
      }
    }

    const keys = scenarioWindowKeys(scenario);
    const totals = await Promise.all(keys.map((k) => engine.windowTotal(k)));

    return Response.json({
      seed,
      uniqueEvents: scenario.events.length,
      delivered: arrival.length,
      ingest: ingestResult,
      sealed: sealResult.newlySealed,
      straggler,
      totals,
    });
  } catch (e) {
    return jsonError(e);
  }
}
