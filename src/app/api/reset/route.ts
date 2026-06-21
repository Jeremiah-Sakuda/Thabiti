import { markRunStart } from "@/lib/acu";
import { getEngine } from "@/lib/engine";
import { jsonError, requireApiKey } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Drop all state and zero the cost meter (start of a fresh demo run). */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireApiKey(req);
  if (unauthorized) return unauthorized;
  try {
    const engine = await getEngine();
    await engine.reset();
    markRunStart();
    return Response.json({ ok: true });
  } catch (e) {
    return jsonError(e);
  }
}
