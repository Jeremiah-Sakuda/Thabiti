/** Browser-side API client (same-origin relative URLs). */

import type { GaugeBreakerView, ReplayView, StateView } from "./api-types";
import type { IngestResult, SealResult, UsageEvent, WindowTotal } from "./engine/types";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const client = {
  reset: () => post<{ ok: boolean }>("/api/reset"),
  ingest: (events: UsageEvent[], autoSeal = false) =>
    post<IngestResult>("/api/ingest", { events, autoSeal }),
  seal: () => post<SealResult>("/api/seal"),
  state: () => get<StateView>("/api/state"),
  windowTotal: (key: string) => get<WindowTotal>(`/api/windows/${encodeURIComponent(key)}/total`),
  replay: (seed: number, orders = 3) => post<ReplayView>("/api/demo/replay", { seed, orders }),
  gaugeBreaker: (dropTiebreaker: boolean, orders = 6) =>
    post<GaugeBreakerView>("/api/demo/gauge-breaker", { dropTiebreaker, orders }),
};
