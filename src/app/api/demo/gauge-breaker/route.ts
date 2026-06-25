import { formatMicros, parseMicros } from "@/lib/decimal";
import { getConfig } from "@/lib/config";
import { aggregateGauge, aggregateGaugeWeakened, windowForEvent } from "@/lib/engine";
import type { BillingWindow, LoggedEvent } from "@/lib/engine/types";
import { jsonError, requireApiKey } from "../../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Pull the Tiebreaker" (Beat: the total order is load-bearing).
 *
 * One gauge metric (active_seats), two events at the SAME millisecond (11 vs 22).
 * We replay EVERY arrival permutation and compute the billed gauge value:
 *  - dropTiebreaker=false → ORDER BY (event_time, event_id): locked, every order → 22.
 *  - dropTiebreaker=true  → ORDER BY event_time only (DIAGNOSTIC): the tie resolves by
 *    arrival order, so the value flickers 22/11 — a real invoice becomes a coin flip.
 *
 * The OFF path runs a genuinely weakened comparator over genuinely-shuffled
 * arrivals (no random() faking the result). It is never used for billing.
 */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i]!, ...p]);
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const unauthorized = requireApiKey(req);
  if (unauthorized) return unauthorized;
  try {
    const body = (await req.json().catch(() => ({}))) as { dropTiebreaker?: boolean; orders?: number };
    const dropTiebreaker = body.dropTiebreaker === true;
    const cfg = getConfig();
    const windowMs = cfg.windowMs;

    const customerId = "00000000-0000-7000-8000-000000000c01";
    const metric = "active_seats"; // a gauge: billed as its latest value
    const base = Math.floor(1_750_000_000_000 / windowMs) * windowMs;
    const tieTime = base + Math.floor(windowMs * 0.8);

    const mk = (eventId: string, q: number, t: number): LoggedEvent => ({
      eventId,
      customerId,
      metric,
      quantityMicros: parseMicros(q),
      eventTime: t,
      ingestTime: t,
      payload: {},
    });

    // Two events share tieTime; the earlier one is a distractor.
    const tieLo = mk("00000000-0000-7000-8000-00000000aaaa", 11, tieTime);
    const tieHi = mk("00000000-0000-7000-8000-00000000ffff", 22, tieTime);
    const events = [mk("00000000-0000-7000-8000-00000000aa00", 999, base + 1000), tieLo, tieHi];

    const spec = windowForEvent(customerId, metric, base, windowMs);
    const window: BillingWindow = {
      windowKey: spec.windowKey,
      customerId,
      metric,
      windowOpen: spec.windowOpen,
      windowClose: spec.windowClose,
      state: "open",
      sealedAt: null,
      sealedWatermark: null,
    };

    const allPerms = permutations(events);
    const want = Math.min(Math.max(body.orders ?? allPerms.length, 1), allPerms.length);
    const aggregate = dropTiebreaker ? aggregateGaugeWeakened : aggregateGauge;

    const runs = allPerms.slice(0, want).map((perm, i) => ({
      order: i + 1,
      arrival: perm.map((e) => e.eventId.slice(-4)),
      value: formatMicros(aggregate(perm, window).micros),
    }));

    const distinct = [...new Set(runs.map((r) => r.value))];

    return Response.json({
      dropTiebreaker,
      metric,
      tie: {
        eventTime: tieTime,
        events: [
          { eventId: tieLo.eventId.slice(-4), quantity: formatMicros(tieLo.quantityMicros) },
          { eventId: tieHi.eventId.slice(-4), quantity: formatMicros(tieHi.quantityMicros) },
        ],
      },
      orderBy: dropTiebreaker ? "event_time_ms" : "event_time_ms, event_id",
      runs,
      distinct,
      stable: distinct.length === 1,
    });
  } catch (e) {
    return jsonError(e);
  }
}
