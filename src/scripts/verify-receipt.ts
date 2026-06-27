/**
 * Standalone invoice verifier — the "don't trust the bill, verify it" tool.
 *
 *   npm run verify -- <audit-bundle.json>      # or pipe JSON on stdin
 *
 * Reads an audit bundle (one window's {receipt, leaves}, an array of them, or
 * {windows:[...]}) and INDEPENDENTLY recomputes every Merkle root + billed total
 * from the leaves, checks them against the receipt, validates the HMAC signature,
 * and reports the grand total + invoice root. It imports only src/lib/verify.ts
 * (Web Crypto) — ZERO dependency on the metering engine. A customer could run an
 * equivalent in any language; this is the proof that "verifiable" is real.
 */

import { readFileSync } from "node:fs";

import type { AuditBundle } from "../lib/api-types";
import { verifyInvoice } from "../lib/verify";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function fmt(micros: string): string {
  const neg = micros.startsWith("-");
  const a = (neg ? micros.slice(1) : micros).padStart(7, "0");
  return `${neg ? "-" : ""}${a.slice(0, -6)}.${a.slice(-6)}`;
}

function readInput(): string {
  const arg = process.argv[2];
  if (arg && arg !== "-") return readFileSync(arg, "utf8");
  return readFileSync(0, "utf8"); // stdin
}

async function main(): Promise<void> {
  const raw = JSON.parse(readInput()) as AuditBundle | AuditBundle[] | { windows: AuditBundle[] };
  const bundles: AuditBundle[] = Array.isArray(raw)
    ? raw
    : "windows" in raw
      ? raw.windows
      : [raw];

  if (bundles.length === 0) {
    console.error("no audit bundles to verify");
    process.exit(1);
  }

  console.log(c.bold(`\nThabiti — independent invoice verification (${bundles.length} window${bundles.length === 1 ? "" : "s"})`));
  console.log(c.dim("recomputing Merkle root + billed total from the leaves, with zero engine dependency\n"));

  const inv = await verifyInvoice(bundles);

  for (const w of inv.windows) {
    const tag = w.ok ? c.green("✓") : c.red("✗");
    const bits = [
      w.rootOk ? "root✓" : c.red("root✗"),
      w.totalOk ? "total✓" : c.red("total✗"),
      w.signatureOk ? "sig✓" : c.red("sig✗"),
    ].join(" ");
    console.log(
      `  ${tag} ${w.windowKey.slice(-18).padEnd(18)}  ${fmt(w.recomputedTotalMicros).padStart(14)}  ` +
        c.dim(`${w.eventCount} leaves · ${bits} · root ${w.recomputedRoot.slice(0, 12)}…`),
    );
  }

  console.log();
  console.log(c.dim("  grand total  ") + c.bold(fmt(inv.grandTotalMicros)));
  console.log(c.dim("  invoice root ") + c.bold(inv.invoiceRoot));
  console.log(
    inv.ok
      ? c.green("\n✓ VERIFIED — every window's root and billed total reproduce independently.\n")
      : c.red("\n✗ REJECTED — a recomputed root or total does not match the receipt.\n"),
  );
  process.exit(inv.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
