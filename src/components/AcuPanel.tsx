import type { AcuView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

function Sparkline({ data, color, max }: { data: number[]; color: string; max: number }) {
  const w = 100;
  const h = 34;
  const n = data.length;
  if (n < 2) {
    return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 40 }} />;
  }
  const x = (i: number) => (i / (n - 1)) * w;
  const y = (v: number) => h - 2 - (Math.min(v, max) / Math.max(max, 0.0001)) * (h - 4);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 40, display: "block" }}>
      <path d={area} fill={color} opacity={0.16} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function AcuPanel({
  acu,
  writerHistory,
  readerHistory,
}: {
  acu: AcuView;
  writerHistory: number[];
  readerHistory: number[];
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Aurora Serverless v2 — capacity & cost</span>
        <span className={styles.panelHint}>
          {acu.source} · min {acu.minAcu} / max {acu.maxAcu} ACU
        </span>
      </div>
      <div className={styles.panelBody}>
        <div className={styles.acuGrid}>
          <div className={styles.acuCell}>
            <div className={styles.acuLabel}>
              <span className={`${styles.swatch} ${styles.swatchWriter}`} /> Writer endpoint · ingest
            </div>
            <div className={styles.acuValue}>
              {acu.writerAcu.toFixed(2)}
              <span className={styles.acuUnit}>ACU</span>
            </div>
            <Sparkline data={writerHistory} color="var(--writer)" max={acu.maxAcu} />
          </div>
          <div className={styles.acuCell}>
            <div className={styles.acuLabel}>
              <span className={`${styles.swatch} ${styles.swatchReader}`} /> Reader endpoint · aggregation
            </div>
            <div className={styles.acuValue}>
              {acu.readerAcu.toFixed(2)}
              <span className={styles.acuUnit}>ACU</span>
            </div>
            <Sparkline data={readerHistory} color="var(--reader)" max={acu.maxAcu} />
          </div>
        </div>
        <div className={styles.costRow}>
          <div>
            <div className={styles.costLabel}>Cost of this run (ACU-seconds × published price)</div>
            <div className={styles.costMeta}>
              {(acu.acuSecondsWriter + acu.acuSecondsReader).toFixed(2)} ACU-s · ${acu.acuHourUsd}/ACU-hr · idle → $0
            </div>
          </div>
          <div className={styles.costValue}>${acu.costUsd.toFixed(6)}</div>
        </div>
      </div>
    </section>
  );
}
