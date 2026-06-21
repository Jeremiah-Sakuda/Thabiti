-- Billed total for a window, computed deterministically on the reader endpoint.
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
