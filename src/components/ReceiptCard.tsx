"use client";

import { useCallback, useEffect, useState } from "react";

import { client } from "@/lib/api-client";
import type { AuditBundle, EnrichedWindow } from "@/lib/api-types";
import { verifyBundle, type VerifyResult } from "@/lib/verify";
import styles from "@/app/dashboard.module.css";

/**
 * Customer-verifiable receipt card. Fetches a sealed window's audit bundle and
 * runs the SAME standalone verifier (src/lib/verify.ts, Web Crypto) right here in
 * the browser — independently of the engine — to drive a VERIFIED badge. The
 * Tamper button edits one leaf and re-verifies: the recomputed root no longer
 * matches the signed root, so the bill is rejected, live on screen.
 */
export function ReceiptCard({ windows }: { windows: EnrichedWindow[] }) {
  const sealed = windows.find((w) => w.state === "sealed");
  const sealedKey = sealed?.windowKey ?? null;

  const [bundle, setBundle] = useState<AuditBundle | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [tampered, setTampered] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sealedKey) return;
    let alive = true;
    setLoading(true);
    setTampered(false);
    (async () => {
      try {
        const b = await client.receipt(sealedKey);
        if (!alive) return;
        setBundle(b);
        setResult(await verifyBundle(b));
      } catch {
        if (alive) {
          setBundle(null);
          setResult(null);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sealedKey]);

  const tamper = useCallback(async () => {
    if (!bundle || bundle.leaves.length === 0) return;
    const forged: AuditBundle = {
      receipt: bundle.receipt, // attacker keeps the signed receipt…
      leaves: bundle.leaves.map((l, i) =>
        i === 0 ? { ...l, quantityMicros: (BigInt(l.quantityMicros) + 500_000_000n).toString() } : l,
      ), // …but inflates one leaf by +500 units
    };
    setTampered(true);
    setResult(await verifyBundle(forged));
  }, [bundle]);

  const restore = useCallback(async () => {
    if (!bundle) return;
    setTampered(false);
    setResult(await verifyBundle(bundle));
  }, [bundle]);

  const r = bundle?.receipt;

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Verify the bill — customer-auditable receipt</span>
        <span className={styles.panelHint}>sha256 Merkle · HMAC-signed</span>
      </div>
      <div className={styles.panelBody}>
        {!sealedKey && (
          <div className={styles.replayIdle}>Seal a window to mint a verifiable receipt.</div>
        )}

        {sealedKey && (
          <>
            {result && (
              <div
                className={`${styles.receiptBadge} ${result.ok ? styles.receiptOk : styles.receiptBad}`}
              >
                {result.ok ? "✓ VERIFIED" : "✗ REJECTED"}
                <span className={styles.receiptBadgeSub}>
                  {result.ok
                    ? "root + total + signature reproduce independently"
                    : "recomputed root ≠ signed root — bill rejected"}
                </span>
              </div>
            )}

            <dl className={styles.receiptGrid}>
              <dt>window</dt>
              <dd className={styles.mono}>{r ? r.windowKey.slice(-18) : "…"}</dd>
              <dt>billed total</dt>
              <dd className={styles.mono}>{r ? r.billedTotal : "…"}</dd>
              <dt>events</dt>
              <dd className={styles.mono}>{r ? r.eventCount : "…"}</dd>
              <dt>signed root</dt>
              <dd className={styles.mono}>{r ? r.merkleRoot.slice(0, 24) + "…" : "…"}</dd>
              <dt>recomputed</dt>
              <dd className={`${styles.mono} ${result && !result.rootOk ? styles.receiptMismatch : ""}`}>
                {result ? result.recomputedRoot.slice(0, 24) + "…" : "…"}
              </dd>
            </dl>

            <div className={styles.breakerRow}>
              {!tampered ? (
                <button className={styles.btn} onClick={() => void tamper()} disabled={loading || !bundle}>
                  ✎ Tamper with a leaf
                </button>
              ) : (
                <button className={styles.btn} onClick={() => void restore()} disabled={loading}>
                  ↺ Restore the real bundle
                </button>
              )}
              <span className={styles.receiptHint}>
                {tampered
                  ? "one leaf edited — the customer's own verifier rejects it"
                  : "anyone can re-run this check with `npm run verify`"}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
