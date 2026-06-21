import { recordIngest } from "@/lib/acu";
import { getEngine } from "@/lib/engine";
import type { UsageEvent } from "@/lib/engine/types";
import { jsonError } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Append a batch of events. Idempotent on event_id; quarantines late-after-seal. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { events?: UsageEvent[]; autoSeal?: boolean };
    if (!Array.isArray(body.events)) {
      return jsonError(new Error("body.events must be an array of events"));
    }
    const engine = await getEngine();
    const result = await engine.ingest(body.events, { autoSeal: body.autoSeal === true });
    recordIngest(body.events.length);
    return Response.json(result);
  } catch (e) {
    return jsonError(e);
  }
}
