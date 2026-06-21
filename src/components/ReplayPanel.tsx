import type { ReplayView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

export function ReplayPanel({ replay, running }: { replay: ReplayView | null; running: boolean }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Replay — same set, 3 arrival orders</span>
        <span className={styles.panelHint}>byte-identical or it&apos;s a bug</span>
      </div>
      <div className={styles.panelBody}>
        {!replay && !running && (
          <div className={styles.replayIdle}>
            Run the demo (or “Replay ×3”) to prove the total is invariant to arrival order.
          </div>
        )}
        {running && !replay && <div className={styles.replayIdle}>replaying…</div>}
        {replay && (
          <>
            <div className={styles.replayCols}>
              {replay.runs.map((r) => (
                <div className={styles.replayCol} key={r.order}>
                  <div className={styles.replayOrder}>order #{r.order}</div>
                  <div className={styles.replayDelivered}>{r.delivered} delivered</div>
                  <div className={styles.replayTotal}>{r.grandTotal}</div>
                </div>
              ))}
            </div>
            <div className={`${styles.replayVerdict} ${replay.allEqual ? styles.verdictEqual : styles.verdictDiverged}`}>
              {replay.allEqual
                ? `✓ identical to the byte — Σ ${replay.grandTotal}`
                : "✗ totals diverged"}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
