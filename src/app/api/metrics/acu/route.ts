import { acuSnapshot } from "@/lib/acu";
import { getConfig } from "@/lib/config";
import { jsonError } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live writer/reader ACU + integrated cost-per-run. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await acuSnapshot(getConfig()));
  } catch (e) {
    return jsonError(e);
  }
}
