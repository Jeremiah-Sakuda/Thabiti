-- Thabiti schema — append-only event log + watermark/window/quarantine state.
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
