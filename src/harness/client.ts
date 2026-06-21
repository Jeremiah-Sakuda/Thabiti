/** Thin HTTP client for the Thabiti API, used by the chaos harness. */

import type { IngestResult, SealResult, UsageEvent, WindowTotal } from "../lib/engine/types";

export const BASE_URL = process.env.THABITI_BASE_URL ?? "http://localhost:3000";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE_URL + path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface AcuView {
  writerAcu: number;
  readerAcu: number;
  minAcu: number;
  maxAcu: number;
  source: string;
  costUsd: number;
  acuHourUsd: number;
  acuSecondsWriter: number;
  acuSecondsReader: number;
  runSeconds: number;
}

export interface EnrichedWindow {
  windowKey: string;
  customerId: string;
  metric: string;
  state: "open" | "sealed";
  billedTotal: string;
  billedTotalMicros: string;
  eventCount: number;
}

export interface StateView {
  backend: string;
  config: { windowMs: number; latenessGraceMs: number; region: string; acuHourUsd: number; minAcu: number; maxAcu: number };
  windows: EnrichedWindow[];
  watermarks: { customerId: string; metric: string; watermark: number }[];
  corrections: { eventId: string; reason: string; quantity: string; windowKey: string }[];
  acu: AcuView;
}

export const api = {
  reset: () => post<{ ok: boolean }>("/api/reset"),
  ingest: (events: UsageEvent[], autoSeal = false) =>
    post<IngestResult>("/api/ingest", { events, autoSeal }),
  seal: () => post<SealResult>("/api/seal"),
  state: () => get<StateView>("/api/state"),
  acu: () => get<AcuView>("/api/metrics/acu"),
  windowTotal: (key: string) => get<WindowTotal>(`/api/windows/${encodeURIComponent(key)}/total`),
  replay: (seed: number, orders = 3) =>
    post<{ allEqual: boolean; grandTotal: string; runs: { order: number; delivered: number; grandTotal: string }[] }>(
      "/api/demo/replay",
      { seed, orders },
    ),
};

/** Grand total (sum of every window's billed micro-units) from the live state. */
export async function grandTotalMicros(): Promise<bigint> {
  const s = await api.state();
  let g = 0n;
  for (const w of s.windows) g += BigInt(w.billedTotalMicros);
  return g;
}

export async function ingestedEventCount(): Promise<number> {
  const s = await api.state();
  return s.windows.reduce((n, w) => n + w.eventCount, 0);
}
