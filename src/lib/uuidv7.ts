/**
 * Client-generated UUIDv7. Time-ordered (48-bit Unix-ms prefix), so ids sort by
 * creation time; doubles as the dedup key and the tiebreaker in the total order
 * `(event_time, event_id)`. Accepts an injectable RNG so the chaos harness can
 * generate a byte-for-byte reproducible event set from a seed.
 */

export type Rng = () => number; // returns a float in [0, 1)

export function uuidv7(tsMs: number = Date.now(), rnd: Rng = Math.random): string {
  const bytes = new Uint8Array(16);

  // 48-bit big-endian millisecond timestamp in bytes 0..5.
  const ts = BigInt(Math.floor(tsMs));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Remaining bytes random.
  for (let i = 6; i < 16; i++) {
    bytes[i] = Math.floor(rnd() * 256) & 0xff;
  }

  // Version 7 (high nibble of byte 6) and RFC-4122 variant (top bits of byte 8).
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuid(bytes);
}

function formatUuid(b: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(b[i]!.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

/** Deterministic mulberry32 PRNG — seeded, portable, identical across runs. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
