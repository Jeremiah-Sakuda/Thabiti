/**
 * Exact fixed-point decimal arithmetic for billed quantities.
 *
 * The marquee guarantee is "byte-identical across replays". IEEE-754 addition is
 * NOT associative, so summing the same numbers in a different order can yield a
 * different float. We therefore never sum quantities as JS numbers. Instead every
 * quantity is parsed to an integer count of micro-units (scale 1e-6) held in a
 * BigInt. Integer addition is exact and order-independent, so the total is the
 * same regardless of arrival order — and it matches Postgres `numeric`, which is
 * exact arbitrary precision. The Aurora aggregation returns the same micro-unit
 * integer, so memory and aurora totals compare byte-for-byte.
 */

export const SCALE = 6;
export const SCALE_FACTOR = 1_000_000n;

/** Parse a quantity (number or decimal string) into exact micro-units. */
export function parseMicros(input: number | string): bigint {
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error(`non-finite quantity: ${input}`);
    }
    // toFixed(SCALE) renders a fixed-6-decimal string with no scientific
    // notation for any |n| < 1e21 — exactly the precision we retain.
    s = input.toFixed(SCALE);
  } else {
    s = input.trim();
  }
  if (s === "") throw new Error("empty quantity");

  let sign = 1n;
  if (s[0] === "-") {
    sign = -1n;
    s = s.slice(1);
  } else if (s[0] === "+") {
    s = s.slice(1);
  }

  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracRaw = dot === -1 ? "" : s.slice(dot + 1);

  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracRaw)) {
    throw new Error(`invalid quantity: ${input}`);
  }

  let frac = fracRaw;
  let roundUp = false;
  if (frac.length > SCALE) {
    const dropped = frac.charCodeAt(SCALE) - 48; // first dropped digit
    roundUp = dropped >= 5; // round half-up
    frac = frac.slice(0, SCALE);
  } else {
    frac = frac.padEnd(SCALE, "0");
  }

  let micros = BigInt(intPart || "0") * SCALE_FACTOR + BigInt(frac || "0");
  if (roundUp) micros += 1n;
  return sign * micros;
}

/**
 * Canonical decimal string for a micro-unit total: integer part, a dot, and
 * exactly SCALE fractional digits. Both engines emit this identical string, so
 * "byte-identical" is literally a string equality.
 */
export function formatMicros(micros: bigint): string {
  const neg = micros < 0n;
  const abs = neg ? -micros : micros;
  const intPart = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/** Human-friendly rendering for the UI: thousands separators, trimmed zeros. */
export function prettyMicros(micros: bigint): string {
  const canonical = formatMicros(micros);
  const [intPart, frac = ""] = canonical.replace("-", "").split(".");
  const neg = canonical.startsWith("-");
  const grouped = (intPart ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedFrac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${grouped}${trimmedFrac ? "." + trimmedFrac : ""}`;
}
