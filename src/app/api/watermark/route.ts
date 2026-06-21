import { getEngine } from "@/lib/engine";
import { jsonError } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current watermark for a stream: /api/watermark?customer=<uuid>&metric=<name>. */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const customer = url.searchParams.get("customer");
    const metric = url.searchParams.get("metric");
    if (!customer || !metric) {
      return jsonError(new Error("customer and metric query params are required"));
    }
    const engine = await getEngine();
    return Response.json({ watermark: await engine.watermark(customer, metric) });
  } catch (e) {
    return jsonError(e);
  }
}
