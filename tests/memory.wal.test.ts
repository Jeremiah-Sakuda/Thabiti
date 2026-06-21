import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryMeteringEngine } from "@/lib/engine";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "@/harness/generator";

describe("memory WAL durability", () => {
  it("recovers a bit-identical total from the durable log after a crash, with no re-ingest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thabiti-wal-"));
    const walPath = join(dir, "log.wal.jsonl");
    const windowMs = 10_000;
    const latenessGraceMs = 2000;

    const scenario = buildScenario({ seed: 21, windowMs });
    const keys = scenarioWindowKeys(scenario);

    // Run 1: flood, seal, snapshot totals — all mirrored to the WAL.
    const e1 = new MemoryMeteringEngine({ latenessGraceMs, windowMs, walPath });
    await e1.ingest(arrivalOrder(scenario, 1));
    await e1.sealDueWindows();
    const t1 = new Map<string, string>();
    for (const k of keys) t1.set(k, (await e1.windowTotal(k)).billedTotal);
    await e1.close();

    // "kill -9": e1 is gone. A new engine replays ONLY the durable log.
    const e2 = new MemoryMeteringEngine({ latenessGraceMs, windowMs, walPath });
    const t2 = new Map<string, string>();
    for (const k of keys) t2.set(k, (await e2.windowTotal(k)).billedTotal);
    await e2.close();

    expect(t2).toEqual(t1);

    rmSync(dir, { recursive: true, force: true });
  });
});
