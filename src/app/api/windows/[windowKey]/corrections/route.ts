import { getEngine } from "@/lib/engine";
import { jsonError } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Quarantined late-after-seal events for a window (the audit view). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ windowKey: string }> },
): Promise<Response> {
  try {
    const { windowKey } = await params;
    const engine = await getEngine();
    return Response.json({ corrections: await engine.corrections(decodeURIComponent(windowKey)) });
  } catch (e) {
    return jsonError(e);
  }
}
