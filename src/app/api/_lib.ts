/** Shared helpers for API route handlers. */
export function jsonError(e: unknown, status = 400): Response {
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status });
}

/**
 * Optional API-key gate for mutating routes. Disabled by default (no key set),
 * so the demo and harness run unauthenticated. Set THABITI_API_KEY to require an
 * `x-api-key` header — the production posture for a public ingest surface.
 */
export function requireApiKey(req: Request): Response | null {
  const key = process.env.THABITI_API_KEY;
  if (!key) return null; // auth disabled
  if (req.headers.get("x-api-key") === key) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/** Reject oversized ingest batches (defends the writer from unbounded payloads). */
export function enforceBatchLimit(count: number): Response | null {
  const max = Number(process.env.THABITI_MAX_BATCH ?? 5000);
  if (count > max) {
    return Response.json({ error: `batch too large: ${count} events > limit ${max}` }, { status: 413 });
  }
  return null;
}
