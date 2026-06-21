import { getEngine } from "@/lib/engine";
import { jsonError } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List billing windows (optionally filtered) for the timeline UI. */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const customerId = url.searchParams.get("customer") ?? undefined;
    const metric = url.searchParams.get("metric") ?? undefined;
    const engine = await getEngine();
    return Response.json({ windows: await engine.windows({ customerId, metric }) });
  } catch (e) {
    return jsonError(e);
  }
}
