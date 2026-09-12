CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO processed_webhook_events (event_id, processed_at)
SELECT event_id, received_at
FROM stripe_webhook_events
ON CONFLICT (event_id) DO NOTHING;