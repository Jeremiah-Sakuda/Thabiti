"use client";

import { useState } from "react";

import { client } from "@/lib/api-client";
import type { GaugeBreakerView } from "@/lib/api-types";
import styles from "@/app/dashboard.module.css";

export function GaugeBreaker() {
  const [breakerOn, setBreakerOn] = useState(true);
  const [result, setResult] = useState<GaugeBreakerView | null>(null);
  const [running, setRunning] = useState(false);

  const replay = async (on: boolean) => {
    setRunning(true);
    try {
      setResult(await client.gaugeBreaker(/* dropTiebreaker */ !on, 6));
    } finally {
      setRunning(false);
    }
  };

  const flip = () => {
    const next = !breakerOn;
    setBreakerOn(next);
    setResult(null); // make the judge re-replay to see the effect
  };

  // The "winning" (correct) value is the max distinct value — what a true total
  // order locks onto. Off-path chips that differ from it are the coin-flip.
  const locked = result ? result.distinct.slice().sort().at(-1)! : null;

  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>Pull the tiebreaker — is the total order load-bearing?</span>
        <span className={styles.panelHint}>gauge · active_seats</span>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.breakerLede}>
          Two events at the <b>same millisecond</b> — a customer reported{" "}
          <span className={styles.breakerSeat}>11</span> then{" "}
          <span className={styles.breakerSeat}>22</span> seats. A gauge bills the{" "}
          <i>latest</i> value, so which one is &ldquo;latest&rdquo; <b>is the invoice</b>.
        </p>

        <pre className={styles.sql}>
          <span className={styles.sqlKw}>ORDER BY</span> event_time_ms
          {breakerOn ? (
            <span className={styles.sqlHl}>, event_id</span>
          ) : (
            <>
              <span className={styles.sqlStruck}>, event_id</span>
              <span className={styles.sqlDiag}>  -- tiebreaker removed (diagnostic)</span>
            </>
          )}
        </pre>

        <div className={styles.breakerRow}>
          <button
            type="button"
            className={`${styles.breaker} ${breakerOn ? styles.breakerOnBtn : styles.breakerOffBtn}`}
            onClick={flip}
            aria-pressed={breakerOn}
          >
            <span className={styles.breakerKnob} />
            <span>tiebreaker {breakerOn ? "ON" : "OFF"}</span>
          </button>
          <button className={styles.btn} onClick={() => void replay(breakerOn)} disabled={running}>
            {running ? "replaying…" : "Replay ×6 arrival orders"}
          </button>
        </div>

        {!result && !running && (
          <div className={styles.replayIdle}>
            Replay all six arrival orders of the same two events. With the tiebreaker ON the bill is
            locked; flip it OFF and replay to watch the invoice become a coin flip.
          </div>
        )}

        {result && (
          <>
            <div className={styles.breakerChips}>
              {result.runs.map((r) => {
                const isLocked = r.value === locked;
                return (
                  <div
                    key={r.order}
                    className={`${styles.breakerChip} ${isLocked ? styles.chipGood : styles.chipBad}`}
                  >
                    <span className={styles.chipArrival}>{r.arrival.join("→")}</span>
                    <span className={styles.chipValue}>{r.value}</span>
                  </div>
                );
              })}
            </div>
            <div
              className={`${styles.replayVerdict} ${result.stable ? styles.verdictEqual : styles.verdictDiverged}`}
            >
              {result.stable
                ? `✓ LOCKED — every arrival order bills ${result.distinct[0]}`
                : `✗ COIN FLIP — the invoice flickers ${result.distinct.join(" / ")} by arrival order`}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
