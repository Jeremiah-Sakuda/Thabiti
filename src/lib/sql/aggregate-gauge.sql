-- Gauge value for a window (last-write-wins) on the reader endpoint.
-- Same TOTAL ORDER (event_time_ms, event_id); here the event_id tiebreaker is
-- strictly load-bearing — it makes "the latest value" deterministic when two
-- events share an event_time. The billed value is the greatest row's quantity.
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
    quantity_micros,
    ROW_NUMBER() OVER (ORDER BY event_time_ms DESC, event_id DESC) AS rn  -- the total order, reversed
  FROM windowed
)
SELECT
  COALESCE((SELECT quantity_micros FROM ordered WHERE rn = 1), 0)::text AS billed_total_micros,
  (SELECT COUNT(*) FROM windowed)::int AS event_count;
