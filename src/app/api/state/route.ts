import { acuSnapshot, recordAggregation } from "@/lib/acu";
import { getConfig } from "@/lib/config";
import { getEngine } from "@/lib/engine";
import type { CorrectionRecord, WatermarkState } from "@/lib/engine/types";
import { jsonError } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single combined snapshot powering the live control surface: every window with
 * its deterministic total, per-stream watermarks, recent quarantines, and the
 * ACU/cost readout. Recomputing every window's total each poll is intentional —
 * it is the deterministic SQL folding the log, and it is what drives reader ACU.
 */
export async function GET(): Promise<Response> {
  try {
    const cfg = getConfig();
    const engine = await getEngine();
    const windows = await engine.windows();

    let aggRows = 0;
    const enriched = await Promise.all(
      windows.map(async (w) => {
        const t = await engine.windowTotal(w.windowKey);
        aggRows += t.eventCount;
        return {
          ...w,
          billedTotal: t.billedTotal,
          billedTotalMicros: t.billedTotalMicros,
          eventCount: t.eventCount,
        };
      }),
    );
    recordAggregation(aggRows);

    // Per-stream watermarks.
    const streamKeys = new Set<string>();
    const watermarks: WatermarkState[] = [];
    for (const w of windows) {
      const key = `${w.customerId}:${w.metric}`;
      if (streamKeys.has(key)) continue;
      streamKeys.add(key);
      const wm = await engine.watermark(w.customerId, w.metric);
      if (wm) watermarks.push(wm);
    }

    // Recent quarantines across all windows.
    const corrections: CorrectionRecord[] = [];
    for (const w of windows) corrections.push(...(await engine.corrections(w.windowKey)));
    corrections.sort((a, b) => b.quarantinedAt - a.quarantinedAt);

    const acu = await acuSnapshot(cfg);

    return Response.json({
      backend: engine.backend,
      config: {
        windowMs: cfg.windowMs,
        latenessGraceMs: cfg.latenessGraceMs,
        region: cfg.aurora.region,
        acuHourUsd: cfg.aurora.acuHourUsd,
        minAcu: cfg.aurora.minAcu,
        maxAcu: cfg.aurora.maxAcu,
      },
      windows: enriched,
      watermarks,
      corrections: corrections.slice(0, 50),
      acu,
    });
  } catch (e) {
    return jsonError(e);
  }
}
