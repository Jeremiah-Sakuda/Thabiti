import { getConfig, type ThabitiConfig } from "../config";
import type { MeteringEngine } from "./engine";
import { MemoryMeteringEngine } from "./memory";

/**
 * Build a metering engine for the given config. The Aurora engine is imported
 * lazily so the memory path (local dev, CI, the chaos harness) never loads `pg`.
 */
export async function createEngine(cfg: ThabitiConfig = getConfig()): Promise<MeteringEngine> {
  if (cfg.backend === "aurora") {
    const { AuroraMeteringEngine } = await import("./aurora");
    const engine = new AuroraMeteringEngine({
      writerUrl: cfg.aurora.writerUrl,
      readerUrl: cfg.aurora.readerUrl,
      latenessGraceMs: cfg.latenessGraceMs,
      windowMs: cfg.windowMs,
    });
    await engine.init(); // idempotent schema apply on cold start
    return engine;
  }
  return new MemoryMeteringEngine({
    latenessGraceMs: cfg.latenessGraceMs,
    windowMs: cfg.windowMs,
    walPath: cfg.memoryWal,
  });
}

// Process-wide singleton. In the memory backend this holds the append-only log
// across requests (it IS the durable store unless a WAL is configured); in the
// Aurora backend it holds the pg connection pools.
let singleton: Promise<MeteringEngine> | null = null;

export function getEngine(): Promise<MeteringEngine> {
  if (!singleton) singleton = createEngine();
  return singleton;
}

/** Drop the cached singleton (used after a reset that recreates state). */
export function clearEngineSingleton(): void {
  singleton = null;
}
