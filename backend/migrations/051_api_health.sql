-- AI provider health monitor (apiMonitor.js): one row per check, holding the
-- latest result plus the alert bookkeeping that keeps emails from repeating.
CREATE TABLE IF NOT EXISTS api_health_checks (
  check_key TEXT PRIMARY KEY,          -- anthropic_key | openai_key | anthropic_admin | anthropic_budget
  status TEXT NOT NULL,                -- ok | invalid | no_credit | forbidden | missing | unavailable | rate_limited | over_threshold | not_configured
  message TEXT,
  detail JSONB,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok_at TIMESTAMPTZ,
  last_alerted_at TIMESTAMPTZ,
  alert_signature TEXT                 -- what was last alerted on (status, or month:threshold for budget)
);
