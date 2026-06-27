import { describe, expect, it } from "vitest";

import { MemoryMeteringEngine } from "@/lib/engine";
import { buildReceipt, type ReceiptLeaf } from "@/lib/engine/receipt";
import { verifyBundle } from "@/lib/verify";
import { arrivalOrder, buildScenario, scenarioWindowKeys } from "@/harness/generator";

const windowMs = 10_000;
const latenessGraceMs = 2000;

async function sealedInvoice(order: number) {
  const engine = new MemoryMeteringEngine({ latenessGraceMs, windowMs });
  const scenario = buildScenario({ seed: 55, windowMs, windowCount: 3 });
  await engine.ingest(arrivalOrder(scenario, order));
  await engine.sealDueWindows();
  const keys = scenarioWindowKeys(scenario);
  const bundles = [];
  for (const k of keys) {
    const b = await engine.receiptBundle(k);
    if (b) bundles.push(b);
  }
  await engine.close();
  return bundles;
}

describe("customer-verifiable receipt", () => {
  it("the independent verifier reproduces the root and total of every sealed window", async () => {
    const bundles = await sealedInvoice(1);
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      const v = await verifyBundle(b);
      expect(v.rootOk).toBe(true);
      expect(v.totalOk).toBe(true);
      expect(v.signatureOk).toBe(true);
      expect(v.ok).toBe(true);
      // the receipt's own total matches the verifier's independent recompute
      expect(v.recomputedTotalMicros).toBe(b.receipt.billedTotalMicros);
    }
  });

  it("the Merkle root is replay-order invariant (same root across arrival orders)", async () => {
    const a = await sealedInvoice(1);
    const b = await sealedInvoice(2);
    const rootsA = Object.fromEntries(a.map((x) => [x.receipt.windowKey, x.receipt.merkleRoot]));
    const rootsB = Object.fromEntries(b.map((x) => [x.receipt.windowKey, x.receipt.merkleRoot]));
    expect(rootsB).toEqual(rootsA); // roots are a pure function of the event SET
  });

  it("the engine receipt and the independent verifier agree byte-for-byte", async () => {
    // buildReceipt (engine, node:crypto) vs verifyBundle (verify.ts, Web Crypto).
    const leaves: ReceiptLeaf[] = [
      { eventId: "00000000-0000-7000-8000-0000000000a1", eventTimeMs: 1_750_000_001_000, quantityMicros: 100_000_000n },
      { eventId: "00000000-0000-7000-8000-0000000000a2", eventTimeMs: 1_750_000_002_000, quantityMicros: 50_000_000n },
    ];
    const receipt = buildReceipt({
      windowKey: "c:api_calls:1750000000000",
      customerId: "c",
      metric: "api_calls",
      sealedWatermark: 1_750_000_009_000,
      leaves,
      createdAtMs: 1_750_000_010_000,
    });
    const bundle = {
      receipt,
      leaves: leaves.map((l) => ({ eventId: l.eventId, eventTimeMs: l.eventTimeMs, quantityMicros: l.quantityMicros.toString() })),
    };
    const v = await verifyBundle(bundle);
    expect(v.recomputedRoot).toBe(receipt.merkleRoot); // two independent impls agree
    expect(v.ok).toBe(true);
  });

  it("TAMPERING is caught — flip one leaf's quantity and the verifier rejects", async () => {
    const [bundle] = await sealedInvoice(1);
    expect(bundle).toBeDefined();
    const tampered = {
      receipt: bundle!.receipt, // attacker keeps the signed receipt…
      leaves: bundle!.leaves.map((l, i) => (i === 0 ? { ...l, quantityMicros: "999999000000" } : l)), // …but edits a leaf
    };
    const v = await verifyBundle(tampered);
    expect(v.rootOk).toBe(false); // root no longer matches
    expect(v.ok).toBe(false); // bill rejected
  });
});
