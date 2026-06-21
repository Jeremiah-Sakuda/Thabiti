import type { Backend } from "./engine/types";

export interface AuroraConfig {
  writerUrl: string | undefined;
  readerUrl: string | undefined;
  clusterId: string;
  region: string;
  acuHourUsd: number;
}

export interface ThabitiConfig {
  backend: Backend;
  /** Allowed-lateness bound: watermark = max(event_time seen) − this. */
  latenessGraceMs: number;
  /** Fixed-duration window size in event-time ms. */
  windowMs: number;
  /** Optional durable write-ahead log path for the memory backend. */
  memoryWal: string | null;
  aurora: AuroraConfig;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Read fresh config from the environment (env is authoritative at call time). */
export function getConfig(): ThabitiConfig {
  return {
    backend: process.env.THABITI_BACKEND === "aurora" ? "aurora" : "memory",
    latenessGraceMs: int(process.env.THABITI_LATENESS_GRACE_MS, 2000),
    windowMs: int(process.env.THABITI_WINDOW_MS, 10_000),
    memoryWal: process.env.THABITI_MEMORY_WAL || null,
    aurora: {
      writerUrl: process.env.AURORA_WRITER_URL,
      readerUrl: process.env.AURORA_READER_URL ?? process.env.AURORA_WRITER_URL,
      clusterId: process.env.AURORA_CLUSTER_ID ?? "thabiti-cluster",
      region: process.env.AWS_REGION ?? "us-east-1",
      acuHourUsd: num(process.env.AURORA_ACU_HOUR_USD, 0.12),
    },
  };
}
