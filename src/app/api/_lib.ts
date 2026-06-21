/** Shared helpers for API route handlers. */
export function jsonError(e: unknown, status = 400): Response {
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status });
}
