import { getEngine } from "@/lib/engine";
import { jsonError, requireApiKey } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seal every open window whose close the watermark has passed. */
export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireApiKey(req);
  if (unauthorized) return unauthorized;
  try {
    const engine = await getEngine();
    return Response.json(await engine.sealDueWindows());
  } catch (e) {
    return jsonError(e);
  }
}
