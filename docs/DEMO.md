# Demo runbook (< 3 minutes)

The product is built so this exact run is real and live — the crash is a genuine
`kill -9`, the totals are recomputed by the engine, nothing is scripted theatre.
One seeded command drives all four beats. Lay out a terminal and a browser
(`http://localhost:3000`) side by side. Note the default backend is `memory`
(same invariant, zero cloud deps); set `THABITI_BACKEND=aurora` to run the
identical beats against the live cluster for the recorded submission.

## Setup

```bash
npm install
npm run dev        # terminal 1 — leave running (THABITI_BACKEND=memory, or aurora)
```

Open the dashboard and click **Reset**. Have terminal 2 ready.

## The four beats

### Beat 1 — the flood (0:00–0:30)

In the browser click **Run hostile demo** (or run `npm run harness` in terminal 2).
A seeded firehose — duplicates, out-of-order, clock-skewed, late — hits the
writer.

> *"Real metering traffic is never clean. Watch what comes out the other side."*

On screen: the **writer ACU** sparkline spikes; the **reader ACU** rises as the
deterministic SQL aggregation folds the log.

### Beat 2 — the seal (0:30–1:15)

Windows flip to **SEALED** as the watermark line advances past their close. A
late event whose event-time lands inside a now-sealed window drops into the
**correction-epoch** feed.

> *"A late event just tried to rewrite a sealed invoice. It was rejected and
> quarantined — the sealed number did not move."*

### Beat 3 — the crash (1:15–2:15)

In terminal 2:

```bash
npm run harness:crash
```

The ingester is **hard-killed mid-flood** (`kill -9 <pid>`, shown live). On
restart it resumes from the durable append-only log and the invoice recovers
**bit-identical** to the projection. The replay panel shows the same seeded set
in three arrival orders — **same total, to the byte.**

> *"Crashed mid-invoice. Replayed in three different orders. Same number, to the
> byte."*

### Beat 4 — the collapse (2:15–3:00)

The flood ends. Writer and reader ACU **collapse to ~0**. The run's **cost** is
on screen, computed from measured ACU-seconds × the published Aurora ACU-hour
price.

> *"This provably-correct invoice cost \$X.XX of Aurora compute. Zero idle spend.
> The database scaled to meet a hostile firehose and then disappeared."*

## What to capture for the submission

- The < 3-minute screen recording of the four beats.
- The **AWS console** screenshot (RDS → cluster → Monitoring → Serverless
  Database Capacity) showing writer + reader ACU scaling up and collapsing.
- The architecture diagram ([architecture.svg](architecture.svg)).
- The deployed Vercel link.

## Notes

- The terminal harness (`npm run harness`) also narrates all four beats including
  the real `kill -9`, if you prefer driving from the terminal.
- Everything above works identically on `THABITI_BACKEND=aurora`; the in-memory
  backend is the hot local backup with the same invariant.
