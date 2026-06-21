import { MemoryMeteringEngine } from "@/lib/engine";
import { runInvariantSuite } from "./shared/invariant-suite";

const windowMs = 10_000;
const latenessGraceMs = 2000;

runInvariantSuite({
  label: "memory",
  windowMs,
  latenessGraceMs,
  makeEngine: async () => {
    const e = new MemoryMeteringEngine({ latenessGraceMs, windowMs });
    await e.reset();
    return e;
  },
});
