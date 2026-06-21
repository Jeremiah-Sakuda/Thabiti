import { prettyMicros } from "@/lib/decimal";
import type { StateView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

export function StatStrip({ state }: { state: StateView }) {
  const sealed = state.windows.filter((w) => w.state === "sealed").length;
  const events = state.windows.reduce((n, w) => n + w.eventCount, 0);
  let grand = 0n;
  for (const w of state.windows) grand += BigInt(w.billedTotalMicros);

  return (
    <section className={styles.panel}>
      <div className={styles.panelBody}>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statValue}>{events.toLocaleString()}</div>
            <div className={styles.statLabel}>events billed</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>
              {sealed}/{state.windows.length}
            </div>
            <div className={styles.statLabel}>windows sealed</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>{state.corrections.length}</div>
            <div className={styles.statLabel}>quarantined</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statValue}>{prettyMicros(grand)}</div>
            <div className={styles.statLabel}>invoice total</div>
          </div>
        </div>
      </div>
    </section>
  );
}
