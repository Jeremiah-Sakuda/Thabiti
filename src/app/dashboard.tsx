"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AcuPanel } from "@/components/AcuPanel";
import { QuarantineFeed } from "@/components/QuarantineFeed";
import { ReplayPanel } from "@/components/ReplayPanel";
import { SqlCard } from "@/components/SqlCard";
import { StatStrip } from "@/components/StatStrip";
import { WatermarkTimeline } from "@/components/WatermarkTimeline";
import { client } from "@/lib/api-client";
import type { ReplayView, StateView } from "@/lib/api-types";
import type { UsageEvent } from "@/lib/engine/types";
import { arrivalOrder, buildScenario } from "@/harness/generator";
import { uuidv7 } from "@/lib/uuidv7";
import styles from "./dashboard.module.css";

const SEED = 2026;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Phase = "idle" | "flooding" | "sealing" | "quarantine" | "replaying" | "done";

export function Dashboard() {
  const [state, setState] = useState<StateView | null>(null);
  const [writerHist, setWriterHist] = useState<number[]>([]);
  const [readerHist, setReaderHist] = useState<number[]>([]);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [replayRunning, setReplayRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [recentlySealed, setRecentlySealed] = useState<Set<string>>(new Set());

  const prevSealed = useRef<Set<string>>(new Set());

  // Poll the combined state on an interval — this also folds the log on the
  // reader, which is what makes reader ACU rise during the demo.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await client.state();
        if (!alive) return;
        setState(s);
        setWriterHist((h) => [...h, s.acu.writerAcu].slice(-80));
        setReaderHist((h) => [...h, s.acu.readerAcu].slice(-80));

        const nowSealed = new Set(s.windows.filter((w) => w.state === "sealed").map((w) => w.windowKey));
        const fresh = [...nowSealed].filter((k) => !prevSealed.current.has(k));
        if (fresh.length) {
          setRecentlySealed((cur) => new Set([...cur, ...fresh]));
          setTimeout(() => {
            setRecentlySealed((cur) => {
              const next = new Set(cur);
              for (const k of fresh) next.delete(k);
              return next;
            });
          }, 1200);
        }
        prevSealed.current = nowSealed;
      } catch {
        /* server momentarily busy — keep polling */
      }
    };
    void tick();
    const id = setInterval(tick, 800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const windowMs = state?.config.windowMs ?? 10_000;
  const customers = state ? [...new Set(state.windows.map((w) => w.customerId))].sort() : [];

  const doReset = useCallback(async () => {
    setReplay(null);
    setPhase("idle");
    prevSealed.current = new Set();
    await client.reset();
  }, []);

  const doFlood = useCallback(async () => {
    setPhase("flooding");
    const scenario = buildScenario({ seed: SEED, windowMs });
    const arrival = arrivalOrder(scenario, SEED);
    const CHUNK = 40;
    for (let i = 0; i < arrival.length; i += CHUNK) {
      await client.ingest(arrival.slice(i, i + CHUNK));
      await sleep(55);
    }
  }, [windowMs]);

  const doSeal = useCallback(async () => {
    setPhase("sealing");
    await client.seal();
  }, []);

  const doQuarantine = useCallback(async () => {
    setPhase("quarantine");
    const s = await client.state();
    const sealed = s.windows.find((w) => w.state === "sealed");
    if (!sealed) return;
    const straggler: UsageEvent = {
      eventId: uuidv7(),
      customerId: sealed.customerId,
      metric: sealed.metric,
      quantity: 9999,
      eventTime: sealed.windowOpen + Math.floor((sealed.windowClose - sealed.windowOpen) / 2),
      payload: { straggler: true },
    };
    await client.ingest([straggler]);
  }, []);

  const doReplay = useCallback(async () => {
    setReplayRunning(true);
    setPhase("replaying");
    try {
      setReplay(await client.replay(SEED, 3));
    } finally {
      setReplayRunning(false);
    }
  }, []);

  const runAll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await doReset();
      await doFlood();
      await doSeal();
      await doQuarantine();
      await doReplay();
      setPhase("done");
    } finally {
      setBusy(false);
    }
  }, [busy, doReset, doFlood, doSeal, doQuarantine, doReplay]);

  const acu = state?.acu;
  const backend = state?.backend ?? "…";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>
            <span className={styles.logo}>
              Thabiti<span className={styles.logoDot}>.</span>
            </span>
            <span className={styles.tagline}>the metering engine that makes a usage invoice provably correct</span>
          </div>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge}>
            <span className={styles.badgeDot} /> backend <b>{backend}</b>
          </span>
          <span className={styles.badge}>
            region <b>{state?.config.region ?? "us-west-2"}</b>
          </span>
          <span className={styles.badge}>
            ACU source <b>{acu?.source ?? "—"}</b>
          </span>
        </div>
      </header>

      <div className={styles.marquee}>
        <strong>Watermark-bounded temporal determinism.</strong> The billed total for a window is{" "}
        <span className={styles.hl}>byte-identical across replays</span> despite late, out-of-order, and
        clock-skewed events — and once a window is <span className={styles.hl}>SEALED</span>, no later event
        can ever mutate it.
      </div>

      <div className={styles.controls}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={runAll} disabled={busy}>
          {busy ? "running…" : "▶ Run hostile demo"}
        </button>
        <button className={styles.btn} onClick={() => void doFlood()} disabled={busy}>
          Flood
        </button>
        <button className={styles.btn} onClick={() => void doSeal()} disabled={busy}>
          Seal
        </button>
        <button className={styles.btn} onClick={() => void doQuarantine()} disabled={busy}>
          Late straggler
        </button>
        <button className={styles.btn} onClick={() => void doReplay()} disabled={busy}>
          Replay ×3
        </button>
        <button className={styles.btn} onClick={() => void doReset()} disabled={busy}>
          Reset
        </button>
        <span className={styles.phasePill}>
          phase <b>{phase}</b>
        </span>
      </div>

      {state && <StatStrip state={state} />}
      <div style={{ height: 18 }} />
      {acu && <AcuPanel acu={acu} writerHistory={writerHist} readerHistory={readerHist} />}

      <div style={{ height: 18 }} />
      <div className={styles.layout}>
        <div className={styles.col}>
          {state && (
            <WatermarkTimeline
              windows={state.windows}
              watermarks={state.watermarks}
              customers={customers}
              selected={selected}
              onSelect={setSelected}
              recentlySealed={recentlySealed}
            />
          )}
          {state && <QuarantineFeed corrections={state.corrections} />}
        </div>
        <div className={styles.col}>
          <ReplayPanel replay={replay} running={replayRunning} />
          <SqlCard />
        </div>
      </div>
    </div>
  );
}
