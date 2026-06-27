import { createHash, createHmac } from "node:crypto";

import type { AuditBundle, SerializedLeaf, WindowReceiptView } from "../api-types";
import { formatMicros } from "../decimal";
import { aggregationMode, type AggregationMode } from "./determinism";

/** Server-side receipt = the browser-safe DTO (string fields). */
export type WindowReceipt = WindowReceiptView;
export type { AuditBundle, SerializedLeaf };

/**
 * Customer-verifiable invoice receipt.
 *
 * At seal time we commit a Merkle root over the admitted events of a window, in
 * the canonical TOTAL ORDER (event_time_ms, event_id). The root + the billed
 * total are persisted INSIDE the seal transaction, so they cannot be backdated.
 * A customer can then take the audit bundle (receipt + ordered leaves) and, with
 * a standalone verifier that has ZERO dependency on this engine, independently:
 *   1. recompute the Merkle root from the leaves and check it equals the root,
 *   2. recompute the billed total from the leaves (sum for counters, last-write
 *      for gauges) and check it equals the billed total,
 *   3. (optionally) check the HMAC signature over the root.
 *
 * "Don't trust the bill — verify it." The root is replay-invariant for the same
 * reason the total is: the leaves are ordered by the total order, so the tree is
 * a pure function of the event SET. Both engines compute it identically, so it
 * inherits the existing memory↔aurora byte-parity guarantee.
 */

export const RECEIPT_ALGO = "sha256";
export const LEAF_ORDER_RULE = "event_time_ms,event_id ASC";
const LEAF_DOMAIN = "thabiti.leaf.v1";
const NODE_DOMAIN = "thabiti.node.v1";
const EMPTY_DOMAIN = "thabiti.empty.v1";

export interface ReceiptLeaf {
  eventId: string;
  eventTimeMs: number;
  quantityMicros: bigint;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical leaf payload — the exact bytes a verifier must reproduce. */
export function encodeLeaf(leaf: ReceiptLeaf): string {
  return `${leaf.eventId}|${leaf.eventTimeMs}|${leaf.quantityMicros.toString()}`;
}

export function hashLeaf(leaf: ReceiptLeaf): string {
  return sha256(`${LEAF_DOMAIN}\n${encodeLeaf(leaf)}`);
}

function hashNode(left: string, right: string): string {
  return sha256(`${NODE_DOMAIN}\n${left}${right}`);
}

/**
 * Merkle root over leaf hashes. Odd nodes at a level are promoted (carried up)
 * rather than duplicated. Empty set → a fixed domain-separated constant.
 */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return sha256(EMPTY_DOMAIN);
  let level = leafHashes.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashNode(level[i]!, level[i + 1]!));
      else next.push(level[i]!); // promote the lone node
    }
    level = next;
  }
  return level[0]!;
}

/** The billed total over the leaves, by aggregation mode (mirrors the engine). */
export function billedMicros(leaves: ReceiptLeaf[], mode: AggregationMode): bigint {
  if (leaves.length === 0) return 0n;
  if (mode === "gauge") {
    // last-write-wins by the total order = the greatest (event_time, event_id)
    let best = leaves[0]!;
    for (const l of leaves) {
      if (
        l.eventTimeMs > best.eventTimeMs ||
        (l.eventTimeMs === best.eventTimeMs && l.eventId > best.eventId)
      ) {
        best = l;
      }
    }
    return best.quantityMicros;
  }
  let sum = 0n;
  for (const l of leaves) sum += l.quantityMicros;
  return sum;
}

function receiptKey(): string {
  return process.env.THABITI_RECEIPT_KEY || "thabiti-demo-receipt-key";
}

/** HMAC-SHA256 signature over the root — proves the root came from the vendor. */
export function signRoot(root: string, key: string = receiptKey()): string {
  return createHmac("sha256", key).update(root, "utf8").digest("hex");
}

/**
 * Build a window receipt from its admitted events. `leaves` MUST already be in
 * the canonical total order (event_time_ms, event_id ASC).
 */
export function buildReceipt(args: {
  windowKey: string;
  customerId: string;
  metric: string;
  sealedWatermark: number;
  leaves: ReceiptLeaf[];
  createdAtMs: number;
}): WindowReceipt {
  const mode = aggregationMode(args.metric);
  const root = merkleRoot(args.leaves.map(hashLeaf));
  const total = billedMicros(args.leaves, mode);
  return {
    windowKey: args.windowKey,
    customerId: args.customerId,
    metric: args.metric,
    mode,
    sealedWatermark: args.sealedWatermark,
    billedTotalMicros: total.toString(),
    billedTotal: formatMicros(total),
    eventCount: args.leaves.length,
    merkleRoot: root,
    signature: signRoot(root),
    leafOrderRule: LEAF_ORDER_RULE,
    algo: RECEIPT_ALGO,
    createdAtMs: args.createdAtMs,
  };
}

export function toSerializedLeaves(leaves: ReceiptLeaf[]): SerializedLeaf[] {
  return leaves.map((l) => ({
    eventId: l.eventId,
    eventTimeMs: l.eventTimeMs,
    quantityMicros: l.quantityMicros.toString(),
  }));
}
