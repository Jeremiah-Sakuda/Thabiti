/**
 * Standalone, isomorphic receipt verifier — the "don't trust the bill, verify
 * it" primitive. It has ZERO dependency on the metering engine: it re-derives the
 * Merkle root and the billed total from the audit bundle's leaves using only the
 * Web Crypto API (available in Node 20+ and every browser), then checks them
 * against the receipt. This is a SECOND, independent implementation of the same
 * commitment that the engine (src/lib/engine/receipt.ts) builds — if they ever
 * disagree, the bill is wrong. Used by both the CLI (src/scripts/verify-receipt.ts)
 * and the dashboard's ReceiptCard.
 */

import type { AuditBundle, SerializedLeaf } from "./api-types";

const LEAF_DOMAIN = "thabiti.leaf.v1";
const NODE_DOMAIN = "thabiti.node.v1";
const EMPTY_DOMAIN = "thabiti.empty.v1";
const DEFAULT_KEY = "thabiti-demo-receipt-key";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmacSha256(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function encodeLeaf(l: SerializedLeaf): string {
  return `${l.eventId}|${l.eventTimeMs}|${l.quantityMicros}`;
}

async function merkleRoot(leaves: SerializedLeaf[]): Promise<string> {
  if (leaves.length === 0) return sha256(EMPTY_DOMAIN);
  let level = await Promise.all(leaves.map((l) => sha256(`${LEAF_DOMAIN}\n${encodeLeaf(l)}`)));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(await sha256(`${NODE_DOMAIN}\n${level[i]}${level[i + 1]}`));
      else next.push(level[i]!); // promote the lone node
    }
    level = next;
  }
  return level[0]!;
}

function billedMicros(leaves: SerializedLeaf[], mode: "counter" | "gauge"): bigint {
  if (leaves.length === 0) return 0n;
  if (mode === "gauge") {
    let best = leaves[0]!;
    for (const l of leaves) {
      if (l.eventTimeMs > best.eventTimeMs || (l.eventTimeMs === best.eventTimeMs && l.eventId > best.eventId)) {
        best = l;
      }
    }
    return BigInt(best.quantityMicros);
  }
  let sum = 0n;
  for (const l of leaves) sum += BigInt(l.quantityMicros);
  return sum;
}

export interface VerifyResult {
  ok: boolean;
  rootOk: boolean;
  totalOk: boolean;
  signatureOk: boolean;
  windowKey: string;
  eventCount: number;
  recomputedRoot: string;
  claimedRoot: string;
  recomputedTotalMicros: string;
  claimedTotalMicros: string;
}

/** Independently verify one window's audit bundle. */
export async function verifyBundle(bundle: AuditBundle, key: string = DEFAULT_KEY): Promise<VerifyResult> {
  const { receipt, leaves } = bundle;
  const recomputedRoot = await merkleRoot(leaves);
  const recomputedTotal = billedMicros(leaves, receipt.mode);
  const recomputedSig = await hmacSha256(key, recomputedRoot);

  const rootOk = recomputedRoot === receipt.merkleRoot && leaves.length === receipt.eventCount;
  const totalOk = recomputedTotal.toString() === receipt.billedTotalMicros;
  const signatureOk = recomputedSig === receipt.signature;

  return {
    ok: rootOk && totalOk && signatureOk,
    rootOk,
    totalOk,
    signatureOk,
    windowKey: receipt.windowKey,
    eventCount: leaves.length,
    recomputedRoot,
    claimedRoot: receipt.merkleRoot,
    recomputedTotalMicros: recomputedTotal.toString(),
    claimedTotalMicros: receipt.billedTotalMicros,
  };
}

/** Verify a full invoice (many windows): each window + the grand total + an
 * invoice root (Merkle over the per-window roots). */
export interface InvoiceVerifyResult {
  ok: boolean;
  windows: VerifyResult[];
  grandTotalMicros: string;
  invoiceRoot: string;
}

export async function verifyInvoice(bundles: AuditBundle[], key: string = DEFAULT_KEY): Promise<InvoiceVerifyResult> {
  const windows = await Promise.all(bundles.map((b) => verifyBundle(b, key)));
  let grand = 0n;
  for (const w of windows) grand += BigInt(w.recomputedTotalMicros);
  // Invoice root = Merkle over the (verified) per-window roots, in window order.
  const roots = windows.map((w) => w.recomputedRoot).sort();
  let level = roots.length ? roots : [await sha256(EMPTY_DOMAIN)];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(await sha256(`${NODE_DOMAIN}\n${level[i]}${level[i + 1]}`));
      else next.push(level[i]!);
    }
    level = next;
  }
  return {
    ok: windows.every((w) => w.ok),
    windows,
    grandTotalMicros: grand.toString(),
    invoiceRoot: level[0]!,
  };
}
