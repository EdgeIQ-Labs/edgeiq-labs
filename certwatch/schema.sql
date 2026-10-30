-- CertWatch D1 Schema
-- SSL Certificate Expiry Monitor

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active, cancelled, past_due
  max_domains INTEGER NOT NULL DEFAULT 25,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monitored_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_expiry_date TEXT,
  last_issuer TEXT,
  last_status TEXT, -- valid, expiring_soon, expired, error
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  domain TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- 30_day, 14_day, 7_day, 1_day, expired
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  expiry_date TEXT NOT NULL,
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_monitored_domains_subscriber ON monitored_domains(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_subscriber ON alert_history(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_domain ON alert_history(domain, alert_type);
