import styles from "@/app/dashboard.module.css";

/** The load-bearing SQL, shown verbatim — the total order is what makes the
 * billed number replay-invariant by construction. */
export function SqlCard() {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>The number is a SQL fact</span>
        <span className={styles.panelHint}>runs on the reader endpoint</span>
      </div>
      <div className={styles.panelBody}>
        <pre className={styles.sql}>
          <span className={styles.sqlComment}>{"-- billed total over the append-only log\n"}</span>
          <span className={styles.sqlKw}>SUM</span>
          {"(quantity_micros) "}
          <span className={styles.sqlKw}>OVER</span>
          {" (\n  "}
          <span className={styles.sqlKw}>ORDER BY</span>{" "}
          <span className={styles.sqlHl}>event_time_ms, event_id</span>
          {"  "}
          <span className={styles.sqlComment}>{"-- TOTAL order"}</span>
          {"\n  "}
          <span className={styles.sqlKw}>ROWS BETWEEN UNBOUNDED PRECEDING</span>
          {"\n              "}
          <span className={styles.sqlKw}>AND CURRENT ROW</span>
          {"\n)"}
        </pre>
        <p style={{ fontSize: 11, color: "var(--fg-3)", margin: "10px 0 0", lineHeight: 1.5 }}>
          <code>event_id</code> is unique, so <code>(event_time, event_id)</code> is a <em>total</em> order:
          the running aggregate is identical for any physical row order. The same rule runs in the in-memory
          engine — parity-tested byte-for-byte.
        </p>
      </div>
    </section>
  );
}
