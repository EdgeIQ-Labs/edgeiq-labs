-- EdgeIQ StatusPage D1 Schema
-- Pages: individual status pages owned by subscribers
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_email TEXT NOT NULL,
  stripe_customer_id TEXT,
  tier TEXT NOT NULL DEFAULT 'starter', -- starter|pro|business
  custom_domain TEXT,
  theme_color TEXT DEFAULT '#3dd9ff',
  logo_url TEXT,
  show_uptime_graph INTEGER DEFAULT 1,
  password_hash TEXT, -- NULL = public, non-null = password-protected
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Components: services/endpoints tracked on a page
CREATE TABLE IF NOT EXISTS components (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  group_name TEXT, -- optional grouping (e.g., "API", "Web")
  status TEXT NOT NULL DEFAULT 'operational', -- operational|degraded|partial_outage|major_outage|maintenance
  uptime_pct REAL DEFAULT 100.0,
  last_checked TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Incidents: outage/maintenance events
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating', -- investigating|identified|monitoring|resolved|scheduled|in_progress|completed
  severity TEXT NOT NULL DEFAULT 'minor', -- minor|major|critical
  body TEXT DEFAULT '',
  affected_components TEXT DEFAULT '[]', -- JSON array of component IDs
  scheduled_start TEXT, -- for maintenance windows
  scheduled_end TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Incident updates: timeline entries within an incident
CREATE TABLE IF NOT EXISTS incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Subscribers: email/webhook notification targets per page
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  email TEXT,
  webhook_url TEXT,
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  unsubscribed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Uptime history: daily snapshots for graph rendering
CREATE TABLE IF NOT EXISTS uptime_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id TEXT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  date TEXT NOT NULL, -- YYYY-MM-DD
  uptime_pct REAL NOT NULL,
  checks_total INTEGER DEFAULT 288, -- 5-min intervals = 288/day
  checks_passed INTEGER DEFAULT 288,
  avg_response_ms REAL,
  UNIQUE(component_id, date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug);
CREATE INDEX IF NOT EXISTS idx_pages_owner ON pages(owner_email);
CREATE INDEX IF NOT EXISTS idx_components_page ON components(page_id);
CREATE INDEX IF NOT EXISTS idx_incidents_page ON incidents(page_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_updates_incident ON incident_updates(incident_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_page ON subscribers(page_id);
CREATE INDEX IF NOT EXISTS idx_uptime_component ON uptime_history(component_id, date);
