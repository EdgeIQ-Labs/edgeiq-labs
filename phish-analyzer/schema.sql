-- Phishing Report Analyzer D1 Schema
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  tier TEXT DEFAULT 'pro',
  stripe_customer_id TEXT,
  subscribed_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  score INTEGER NOT NULL,
  indicators_count INTEGER DEFAULT 0,
  urls_found INTEGER DEFAULT 0,
  subscriber_email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_subscriber ON analyses(subscriber_email);
