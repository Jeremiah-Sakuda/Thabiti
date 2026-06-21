import { recordAggregation } from "@/lib/acu";
import { getEngine } from "@/lib/engine";
import { jsonError } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The deterministic billed total for a window (runs the total-order SQL on the reader). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ windowKey: string }> },
): Promise<Response> {
  try {
    const { windowKey } = await params;
    const engine = await getEngine();
    const total = await engine.windowTotal(decodeURIComponent(windowKey));
    recordAggregation(total.eventCount);
    return Response.json(total);
  } catch (e) {
    return jsonError(e);
  }
}
