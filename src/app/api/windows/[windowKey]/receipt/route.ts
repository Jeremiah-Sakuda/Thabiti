import { getEngine } from "@/lib/engine";
import { jsonError } from "../../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer-verifiable audit bundle for a sealed window: the committed Merkle
 * receipt plus the ordered leaves. Hand this to the standalone verifier (or the
 * dashboard's ReceiptCard) to independently recompute the root and billed total.
 * 404 if the window isn't sealed yet (no receipt committed).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ windowKey: string }> },
): Promise<Response> {
  try {
    const { windowKey } = await params;
    const engine = await getEngine();
    const bundle = await engine.receiptBundle(decodeURIComponent(windowKey));
    if (!bundle) {
      return Response.json({ error: "no receipt — window not sealed" }, { status: 404 });
    }
    return Response.json(bundle);
  } catch (e) {
    return jsonError(e);
  }
}
