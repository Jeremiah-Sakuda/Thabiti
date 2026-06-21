/**
 * Canonical SQL for the Aurora backend. These strings are the source of truth
 * the engine executes (embedded so they are always present in the serverless
 * bundle). The human-readable mirrors in schema.sql and aggregate.sql are held
 * byte-identical by tests/sql-drift.test.ts.
 *
 * Money lives as `quantity_micros bigint` — the exact integer the deterministic
 * sum adds — so Aurora and the in-memory engine agree byte-for-byte. Times live
 * as `*_ms bigint` for exact ordering/window math, with generated timestamptz
 * columns for the human-facing audit view.
 */

export const SCHEMA_SQL = `-- Thabiti schema — append-only event log + watermark/window/quarantine state.
CREATE TABLE IF NOT EXISTS event_log (
  event_id        uuid          PRIMARY KEY,              -- UUIDv7, client-generated
  customer_id     uuid          NOT NULL,
  metric          text          NOT NULL,
  quantity        numeric(38,6) NOT NULL,                 -- human/audit value
  quantity_micros bigint        NOT NULL,                 -- exact micro-units the sum adds
  event_time_ms   bigint        NOT NULL,                 -- business time (epoch ms)
  ingest_time_ms  bigint        NOT NULL,                 -- processing time (epoch ms)
  event_time      timestamptz   GENERATED ALWAYS AS (to_timestamp(event_time_ms / 1000.0)) STORED,
  ingest_time     timestamptz   GENERATED ALWAYS AS (to_timestamp(ingest_time_ms / 1000.0)) STORED,
  payload         jsonb         NOT NULL DEFAULT '{}'
);
-- One index serves both the window scan and the total order (event_time_ms, event_id).
CREATE INDEX IF NOT EXISTS ix_event_log_window
  ON event_log (customer_id, metric, event_time_ms, event_id);

CREATE TABLE IF NOT EXISTS stream_watermark (
  customer_id       uuid   NOT NULL,
  metric            text   NOT NULL,
  watermark_ms      bigint NOT NULL,                      -- max(event_time) − lateness grace
  lateness_grace_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, metric)
);

CREATE TABLE IF NOT EXISTS billing_window (
  window_key          text   PRIMARY KEY,                 -- cust:metric:windowStart
  customer_id         uuid   NOT NULL,
  metric              text   NOT NULL,
  window_open_ms      bigint NOT NULL,                    -- inclusive
  window_close_ms     bigint NOT NULL,                    -- exclusive
  state               text   NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed')),
  sealed_at_ms        bigint,
  sealed_watermark_ms bigint
);
CREATE INDEX IF NOT EXISTS ix_billing_window_stream
  ON billing_window (customer_id, metric, state);

CREATE TABLE IF NOT EXISTS correction_epoch (
  correction_id     uuid          PRIMARY KEY,
  window_key        text          NOT NULL REFERENCES billing_window(window_key),
  event_id          uuid          NOT NULL UNIQUE,        -- one quarantine per event
  customer_id       uuid          NOT NULL,
  metric            text          NOT NULL,
  quantity          numeric(38,6) NOT NULL,
  quantity_micros   bigint        NOT NULL,
  event_time_ms     bigint        NOT NULL,
  quarantined_at_ms bigint        NOT NULL,
  reason            text          NOT NULL DEFAULT 'late_after_seal'
);
`;

export const AGGREGATE_SQL = `-- Billed total for a window, computed deterministically on the reader endpoint.
-- TOTAL ORDER: (event_time_ms, event_id). event_id is unique, so the order is
-- total and the running aggregate is replay-invariant BY CONSTRUCTION — the
-- single most important line of SQL in the project.
WITH windowed AS (
  SELECT e.quantity_micros, e.event_time_ms, e.event_id
  FROM event_log e
  JOIN billing_window w
    ON  w.customer_id = e.customer_id
    AND w.metric      = e.metric
    AND e.event_time_ms >= w.window_open_ms
    AND e.event_time_ms <  w.window_close_ms
  WHERE w.window_key = $1
    AND (
      w.state <> 'sealed'                          -- open window: all of it participates
      OR w.sealed_watermark_ms IS NULL
      OR e.event_time_ms <= w.sealed_watermark_ms  -- sealed: nothing past the seal participates
    )
),
ordered AS (
  SELECT
    SUM(quantity_micros) OVER (
      ORDER BY event_time_ms, event_id             -- the total order
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total,
    ROW_NUMBER() OVER (ORDER BY event_time_ms DESC, event_id DESC) AS rn
  FROM windowed
)
SELECT
  COALESCE((SELECT running_total FROM ordered WHERE rn = 1), 0)::text AS billed_total_micros,
  (SELECT COUNT(*) FROM windowed)::int AS event_count;
`;

/** Seal every open window whose close the watermark has passed — one statement. */
export const SEAL_DUE_SQL = `UPDATE billing_window w
SET state = 'sealed', sealed_at_ms = $1, sealed_watermark_ms = sw.watermark_ms
FROM stream_watermark sw
WHERE w.customer_id = sw.customer_id
  AND w.metric = sw.metric
  AND w.state = 'open'
  AND w.window_close_ms <= sw.watermark_ms
RETURNING w.window_key;
`;

/** Recompute a stream's watermark from the log; monotonic via GREATEST. */
export const UPSERT_WATERMARK_SQL = `INSERT INTO stream_watermark (customer_id, metric, watermark_ms, lateness_grace_ms)
SELECT customer_id, metric, MAX(event_time_ms) - $3::bigint, $3::bigint
FROM event_log
WHERE customer_id = $1 AND metric = $2
GROUP BY customer_id, metric
ON CONFLICT (customer_id, metric) DO UPDATE
  SET watermark_ms = GREATEST(stream_watermark.watermark_ms, EXCLUDED.watermark_ms),
      lateness_grace_ms = EXCLUDED.lateness_grace_ms;
`;
