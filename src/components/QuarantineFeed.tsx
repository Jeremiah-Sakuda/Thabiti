import type { CorrectionView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function QuarantineFeed({ corrections }: { corrections: CorrectionView[] }) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Correction epoch — late-after-seal quarantine</span>
        <span className={styles.panelHint}>{corrections.length} quarantined</span>
      </div>
      <div className={styles.panelBody}>
        {corrections.length === 0 ? (
          <div className={styles.feedEmpty}>
            No late rewrites yet. A late event landing in a sealed window appears here — never merged.
          </div>
        ) : (
          <div className={styles.feed}>
            {corrections.map((c) => (
              <div className={styles.feedItem} key={c.correctionId}>
                <span className={styles.feedIcon}>⟶</span>
                <div className={styles.feedMain}>
                  <div className={styles.feedTitle}>
                    late event rejected from sealed window
                  </div>
                  <div className={styles.feedSub}>
                    {shortId(c.eventId)} · {c.metric} · {c.reason}
                  </div>
                </div>
                <span className={styles.feedQty}>+{Number(c.quantity).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
