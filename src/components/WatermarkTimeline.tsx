import { prettyMicros } from "@/lib/decimal";
import type { EnrichedWindow, WatermarkView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function WatermarkTimeline({
  windows,
  watermarks,
  customers,
  selected,
  onSelect,
  recentlySealed,
}: {
  windows: EnrichedWindow[];
  watermarks: WatermarkView[];
  customers: string[];
  selected: string | null;
  onSelect: (c: string) => void;
  recentlySealed: Set<string>;
}) {
  const customer = selected ?? customers[0] ?? null;
  const mine = windows.filter((w) => w.customerId === customer);
  const metrics = [...new Set(mine.map((w) => w.metric))].sort();

  const axisMin = mine.length ? Math.min(...mine.map((w) => w.windowOpen)) : 0;
  const axisMax = mine.length ? Math.max(...mine.map((w) => w.windowClose)) : 1;
  const span = Math.max(axisMax - axisMin, 1);
  const pct = (t: number) => `${((Math.min(Math.max(t, axisMin), axisMax) - axisMin) / span) * 100}%`;

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Watermark timeline — event-time windows</span>
        <div className={styles.tabs}>
          {customers.map((c, i) => (
            <button
              key={c}
              className={`${styles.tab} ${c === customer ? styles.tabActive : ""}`}
              onClick={() => onSelect(c)}
              title={c}
            >
              tenant {i + 1}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.panelBody}>
        {metrics.length === 0 && (
          <div className={styles.replayIdle}>No windows yet — run the flood to populate the log.</div>
        )}
        {metrics.map((metric) => {
          const lane = mine.filter((w) => w.metric === metric).sort((a, b) => a.windowOpen - b.windowOpen);
          const wm = watermarks.find((w) => w.customerId === customer && w.metric === metric);
          return (
            <div className={styles.lane} key={metric}>
              <div className={styles.laneLabel}>
                {shortId(customer ?? "")} · {metric}
                {wm ? `  ·  watermark @ +${((wm.watermark - axisMin) / 1000).toFixed(1)}s` : ""}
              </div>
              <div className={styles.track}>
                {lane.map((w) => {
                  const sealed = w.state === "sealed";
                  return (
                    <div
                      key={w.windowKey}
                      className={`${styles.window} ${sealed ? styles.windowSealed : styles.windowOpen} ${
                        recentlySealed.has(w.windowKey) ? styles.sealFlash : ""
                      }`}
                      style={{ left: pct(w.windowOpen), width: `calc(${pct(w.windowClose)} - ${pct(w.windowOpen)})` }}
                      title={w.windowKey}
                    >
                      <span className={styles.windowTotal}>{prettyMicros(BigInt(w.billedTotalMicros))}</span>
                      <span className={styles.windowState}>{sealed ? "🔒 sealed" : "open"}</span>
                    </div>
                  );
                })}
                {wm && <div className={styles.watermarkLine} style={{ left: pct(wm.watermark) }} />}
              </div>
            </div>
          );
        })}
        <div className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchWriter}`} /> open window
          </span>
          <span className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: "var(--seal)" }} /> sealed (immutable)
          </span>
          <span className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: "var(--accent)", borderRadius: "50%" }} /> watermark
          </span>
        </div>
      </div>
    </section>
  );
}
