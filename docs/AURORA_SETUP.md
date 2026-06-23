# Aurora setup & Vercel deploy

The whole project runs locally with **zero cloud dependencies**
(`THABITI_BACKEND=memory`). Follow this only to run the real Aurora-backed engine
and deploy to Vercel. Region throughout: **`us-west-2`**.

## 1. Provision Aurora PostgreSQL Serverless v2

1. **RDS → Create database → Amazon Aurora → Aurora PostgreSQL** (a recent
   PostgreSQL-compatible version).
2. **Capacity type: Serverless v2.** Set **Minimum ACU = 0** (scale to near-zero
   when idle) and **Maximum ACU = 16** (burst ceiling). These power the
   spike-then-collapse and the cost-per-run story.
3. Create the cluster with a **writer** instance.
4. **Add a reader instance** to the cluster — the aggregation runs here, isolated
   from write pressure. (Optionally enable **Optimized Reads** on a supporting
   instance class; the current single-range-scan query won't spill, so the
   writer/reader split is what matters, not Optimized Reads specifically.)
5. Note the **DBClusterIdentifier** and both **DBInstanceIdentifier**s (writer
   and reader) — used for CloudWatch ACU metrics.
6. Create a database named `thabiti` and a login role.

## 2. RDS Proxy (connection pooling)

Serverless functions + Postgres produce connection storms without pooling.

1. **RDS → Proxies → Create proxy**, target the Aurora cluster, engine
   PostgreSQL, store the DB credentials in Secrets Manager.
2. The proxy exposes a **writer (read/write) endpoint** and a **read-only
   endpoint**. Use these — not the raw cluster endpoints — in the env below.
3. Ensure the proxy and your functions can reach the cluster (VPC/security
   groups). For a public demo, a publicly-accessible proxy with TLS is simplest;
   for production, run functions in the VPC.

## 3. Configure environment

Copy `.env.example` to `.env.local` (Next.js) / `.env` (scripts) and set:

```bash
THABITI_BACKEND=aurora
AURORA_WRITER_URL=postgresql://USER:PASS@<proxy-writer-endpoint>:5432/thabiti?sslmode=require
AURORA_READER_URL=postgresql://USER:PASS@<proxy-readonly-endpoint>:5432/thabiti?sslmode=require
AWS_REGION=us-west-2
AURORA_CLUSTER_ID=thabiti-cluster
AURORA_WRITER_INSTANCE_ID=thabiti-instance-1     # for live CloudWatch ACU
AURORA_READER_INSTANCE_ID=thabiti-reader-1       # for live CloudWatch ACU
AURORA_ACU_HOUR_USD=0.12                          # published Serverless v2 price
AURORA_MIN_ACU=0
AURORA_MAX_ACU=16
```

TLS note: the engine accepts the RDS-managed certificate for the demo. For
production, set `AURORA_CA_CERT` to the [RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
(PEM contents or a file path) — the engine then verifies the chain
(`rejectUnauthorized: true`) instead of trusting all (see `sslFor` in
[`src/lib/engine/aurora.ts`](../src/lib/engine/aurora.ts)).

Hardening note: set `THABITI_API_KEY` to require an `x-api-key` header on the
mutating routes (ingest/seal/reset/demo), and `THABITI_MAX_BATCH` to cap ingest
batch size. Both are off/limit-only by default so the demo runs unauthenticated.

## 4. Apply the schema & verify

```bash
npm run db:schema     # creates event_log, stream_watermark, billing_window, correction_epoch
npm run db:check      # replays one seed in 3 arrival orders → byte-identical total
AURORA_WRITER_URL=... npm test   # runs the identical invariant suite + memory↔aurora parity
```

## 5. Live ACU graphs (optional)

The in-app ACU panel uses real CloudWatch `ServerlessDatabaseCapacity` when the
AWS SDK is installed and instance ids + credentials are present:

```bash
npm install @aws-sdk/client-cloudwatch
```

Otherwise it falls back to an activity-driven estimate. Either way, the
definitive collapse-to-near-zero is visible directly in the **AWS console**
(RDS → the cluster → Monitoring → Serverless Database Capacity) — capture that
for the submission.

## 6. Deploy to Vercel

1. Import the repo into Vercel.
2. `vercel.json` already pins functions to **`pdx1`** (adjacent to the cluster) —
   keep it.
3. Add the env vars from step 3 in the Vercel project settings.
4. Deploy. The serverless functions reach Aurora through RDS Proxy in-region.

## Aurora gotchas

- **Cold scale-up latency.** From min ACU, the first burst takes a moment to
  scale. Pre-warm with a warmup pulse before recording, and narrate the scale-up
  as the feature it is.
- **Reader routing.** Reads must go to the reader endpoint — the engine uses a
  separate `AURORA_READER_URL` pool for exactly this.
- **Total order.** The aggregation's `ORDER BY event_time_ms, event_id` must stay
  a total order; it is guarded by `tests/sql-drift.test.ts`.
