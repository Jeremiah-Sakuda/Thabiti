import { describe, expect, it } from "vitest";

import { formatMicros, parseMicros, prettyMicros, SCALE_FACTOR } from "@/lib/decimal";
import { mulberry32 } from "@/lib/uuidv7";

describe("exact decimal (micro-units)", () => {
  it("parses integers and decimals exactly", () => {
    expect(parseMicros(0)).toBe(0n);
    expect(parseMicros(1)).toBe(1_000_000n);
    expect(parseMicros("1.5")).toBe(1_500_000n);
    expect(parseMicros("0.000001")).toBe(1n);
    expect(parseMicros("-2.25")).toBe(-2_250_000n);
    expect(parseMicros("1000000")).toBe(1_000_000_000_000n);
  });

  it("rounds half-up beyond scale", () => {
    expect(parseMicros("0.0000005")).toBe(1n); // 5th+ decimal rounds up
    expect(parseMicros("0.0000004")).toBe(0n);
  });

  it("formats canonically with exactly 6 fractional digits", () => {
    expect(formatMicros(150_000_000n)).toBe("150.000000");
    expect(formatMicros(1n)).toBe("0.000001");
    expect(formatMicros(-2_250_000n)).toBe("-2.250000");
  });

  it("round-trips parse → format", () => {
    for (const v of ["0.000000", "42.500000", "999999.999999", "7.000000"]) {
      expect(formatMicros(parseMicros(v))).toBe(v);
    }
  });

  it("BigInt summation is order-independent (the core reason totals are stable)", () => {
    const rng = mulberry32(123);
    const values: bigint[] = [];
    for (let i = 0; i < 500; i++) values.push(parseMicros((rng() * 1000).toFixed(6)));

    const forward = values.reduce((a, b) => a + b, 0n);
    const shuffled = values.slice().sort(() => (rng() < 0.5 ? -1 : 1));
    const backward = shuffled.reduceRight((a, b) => a + b, 0n);

    expect(forward).toBe(backward); // exact, regardless of order
  });

  it("pretty-prints with grouping and trimmed zeros", () => {
    expect(prettyMicros(1_234_567_000_000n)).toBe("1,234,567");
    expect(prettyMicros(1_500_000n)).toBe("1.5");
  });

  it("SCALE_FACTOR is 1e6", () => {
    expect(SCALE_FACTOR).toBe(1_000_000n);
  });
});
