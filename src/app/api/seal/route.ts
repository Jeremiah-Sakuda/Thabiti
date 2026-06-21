import { getEngine } from "@/lib/engine";
import { jsonError } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Seal every open window whose close the watermark has passed. */
export async function POST(): Promise<Response> {
  try {
    const engine = await getEngine();
    return Response.json(await engine.sealDueWindows());
  } catch (e) {
    return jsonError(e);
  }
}
