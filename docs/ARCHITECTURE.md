# Architecture

Thabiti is a usage-metering aggregation layer: it ingests a hostile event
firehose and produces an invoice-ready, audited billed total whose value is
**provably reproducible**. This document describes the data model, the exact
algorithm, and how Amazon Aurora PostgreSQL Serverless v2 enforces the guarantee.

## Data flow

```
hostile firehose                Vercel (iad1, us-east-1)            Amazon Aurora Serverless v2
─────────────────               ────────────────────────           ───────────────────────────
duplicates                 ┌─> POST /api/ingest  ──── writes ──┐
out-of-order      ───────> │                                   ├─> RDS Proxy ─> WRITER endpoint ─┐
clock skew                 │   GET  /api/.../total ─ reads ─────┘                                 │  shared
late stragglers            └─> GET  /api/state    ─ reads ─────────> RDS Proxy ─> READER (Opt.   ─┤  MVCC log
                                                                      Reads) endpoint              │  event_log
                                                                                                   ┘ (append-only)
```

- **Writer endpoint** absorbs append-only inserts under load.
- **Optimized-Reads reader endpoint** runs the heavy window-function aggregation,
  isolated from write pressure. Writer and reader scale independently.
- Both endpoints sit over **one MVCC-snapshot-consistent storage layer**, so the
  aggregation reads a single consistent snapshot of the log.
- **RDS Proxy** pools connections so serverless functions never storm Postgres.
- Functions are **pinned to `iad1`** (adjacent to the cluster) via `vercel.json`.

## Data model (append-only log)

The event log is the single source of truth. Append-only: **no updates, no
deletes.** Correction is modeled as new, explicitly-tagged records, never
mutation. (Full DDL: [`src/lib/sql/schema.sql`](../src/lib/sql/schema.sql).)

| Table | Purpose |
|---|---|
| `event_log` | every usage event; PK is the client UUIDv7 (`event_id`); `quantity_micros` is the exact integer the deterministic sum adds; `event_time_ms` is the exact ordering key |
| `stream_watermark` | per `(customer, metric)`: the watermark = `max(event_time) − lateness_grace` |
| `billing_window` | per window: open/sealed state, sealed watermark, seal time |
| `correction_epoch` | quarantined late-after-seal events, with audit metadata |

## The algorithm

1. **Ingest.** Append every event to the log; duplicates are absorbed
   idempotently (`ON CONFLICT (event_id) DO NOTHING`). Plumbing — not the story.
   `event_id` is the idempotency key, so a re-delivery whose payload *differs*
   (same id, different quantity) is a contract violation: the append-only log is
   never mutated, and the conflict is recorded as an audited `payload_conflict`
   correction rather than silently first-write-wins (which would make the total
   arrival-order-dependent).
2. **Watermark advance.** Per stream, `watermark = max(event_time seen) −
   lateness_grace`, monotonic. The watermark is the assertion: "no further events
   with event-time ≤ W will be admitted into an open window."
3. **Window sealing.** A window seals the moment its stream watermark passes the
   window's close. Sealing records the sealed watermark and seal time in one
   transaction. It is a state transition, never a recomputation.
4. **Late-event quarantine.** An event whose event-time falls inside an
   already-sealed window is **not merged** — it is written to the correction
   epoch (visible, audited, attributable). The sealed number never moves.
5. **Deterministic aggregation.** The billed total is one window-function
   aggregation over the log, scoped to the window and bounded by the sealed
   watermark, under the total order `(event_time_ms, event_id)`. Because the
   order is total and the inputs are append-only, the output is byte-identical
   across any number of replays and any arrival order.
6. **Crash-replay.** Re-ingesting the same set in any order yields the identical
   total: ingest is idempotent, sealing is deterministic on the watermark, and
   the aggregate is a pure function of the sealed log under the total order.

### Why seal-at-end on the determinism paths

Under a maximally hostile *full shuffle*, an in-window event can be delivered
after its window's watermark has already passed. Sealing at that moment correctly
quarantines it — but that makes membership arrival-order-dependent. The
determinism guarantees (replay-order invariance, crash-replay equivalence) are
therefore defined over **seal-at-end**: ingest the full set, then seal. Then the
billed total is a pure function of the event *set*. Live sealing during a flood
is still shown (and still correct) — it is the quarantine demonstration, not the
byte-identical-projection claim. See
[`tests/shared/invariant-suite.ts`](../tests/shared/invariant-suite.ts).

## Exact arithmetic

IEEE-754 addition is not associative, so summing in different orders can yield
different floats. Thabiti never sums quantities as JS numbers: every quantity is
parsed to an integer count of micro-units (`bigint`), and the database sums
`quantity_micros` (`bigint` → `numeric`). Integer addition is exact and
order-independent, and the two backends therefore agree to the byte. See
[`src/lib/decimal.ts`](../src/lib/decimal.ts).

## Backends

`MeteringEngine` ([`src/lib/engine/engine.ts`](../src/lib/engine/engine.ts)) has
two implementations selected by `THABITI_BACKEND`:

- **memory** — faithful in-process reproduction of the entire invariant, zero
  cloud deps, with an optional durable write-ahead log that mirrors Aurora's
  durable log so the engine survives a process crash.
- **aurora** — the deterministic SQL is the source of truth; writer/reader pools
  over RDS Proxy.

The same property tests run against both; for any seed the totals match.
