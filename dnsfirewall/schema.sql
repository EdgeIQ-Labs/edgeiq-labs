-- EdgeIQ DNS Firewall D1 Schema
-- Customers: subscriber accounts with tier-based limits
CREATE TABLE IF NOT EXISTS dnsfw_customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  stripe_customer_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free', -- free|personal|business
  max_devices INTEGER DEFAULT 1,
  max_blocklists INTEGER DEFAULT 3,
  custom_allowlist INTEGER DEFAULT 0, -- boolean
  real_time_alerts INTEGER DEFAULT 0, -- boolean
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Devices: customer's protected endpoints (routers, servers, etc.)
CREATE TABLE IF NOT EXISTS dnsfw_devices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES dnsfw_customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  identifier TEXT NOT NULL, -- unique subdomain prefix or IP tag
  queries_today INTEGER DEFAULT 0,
  blocked_today INTEGER DEFAULT 0,
  last_query_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Blocklists: curated threat feed subscriptions per customer
CREATE TABLE IF NOT EXISTS dnsfw_blocklists (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES dnsfw_customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- ads|malware|phishing|tracking|custom
  source_url TEXT, -- upstream list URL (null for custom)
  enabled INTEGER DEFAULT 1,
  domain_count INTEGER DEFAULT 0,
  last_updated TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Custom rules: per-customer allow/block overrides
CREATE TABLE IF NOT EXISTS dnsfw_rules (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES dnsfw_customers(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  action TEXT NOT NULL, -- allow|block|redirect
  target TEXT, -- redirect destination (for redirect action)
  reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Query log: recent DNS queries for dashboard (rolling 24h)
CREATE TABLE IF NOT EXISTS dnsfw_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  device_id TEXT,
  domain TEXT NOT NULL,
  type TEXT NOT NULL, -- A|AAAA|CNAME|MX|TXT|etc.
  action TEXT NOT NULL, -- allowed|blocked|redirected
  blocklist_id TEXT, -- which list caught it (null if allowed/custom)
  response_time_ms REAL,
  queried_at TEXT DEFAULT (datetime('now'))
);

-- Alerts: high-severity blocks worth notifying about
CREATE TABLE IF NOT EXISTS dnsfw_alerts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  device_id TEXT,
  domain TEXT NOT NULL,
  category TEXT NOT NULL, -- malware|phishing|c2|botnet
  severity TEXT NOT NULL, -- low|medium|high|critical
  sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Stats: hourly aggregates for dashboard graphs
CREATE TABLE IF NOT EXISTS dnsfw_stats_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  hour TEXT NOT NULL, -- YYYY-MM-DD-HH
  total_queries INTEGER DEFAULT 0,
  blocked_queries INTEGER DEFAULT 0,
  top_blocked_domain TEXT,
  UNIQUE(customer_id, hour)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_dnsfw_cust_email ON dnsfw_customers(email);
CREATE INDEX IF NOT EXISTS idx_dnsfw_cust_stripe ON dnsfw_customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_dev_cust ON dnsfw_devices(customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_bl_cust ON dnsfw_blocklists(customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_rules_cust ON dnsfw_rules(customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_q_cust ON dnsfw_queries(customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_q_time ON dnsfw_queries(queried_at);
CREATE INDEX IF NOT EXISTS idx_dnsfw_alert_cust ON dnsfw_alerts(customer_id);
CREATE INDEX IF NOT EXISTS idx_dnsfw_stats_cust ON dnsfw_stats_hourly(customer_id, hour);
