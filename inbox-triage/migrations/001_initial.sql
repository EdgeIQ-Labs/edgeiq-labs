-- EdgeIQ Inbox Triage - Database Schema
-- D1 (SQLite-compatible)

-- Customers / tenants
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    stripe_customer_id TEXT UNIQUE,
    stripe_subscription_id TEXT,
    email TEXT NOT NULL UNIQUE,
    company_name TEXT,
    plan TEXT NOT NULL DEFAULT 'starter', -- starter | pro | enterprise
    status TEXT NOT NULL DEFAULT 'active', -- active | trial | cancelled | suspended
    emails_triaged INTEGER DEFAULT 0,
    monthly_limit INTEGER DEFAULT 500, -- starter=500, pro=unlimited
    kb_enabled INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Connected mailboxes per customer
CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    email_address TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'mailflare', -- mailflare | gmail | outlook
    mailbox_external_id TEXT, -- Mailflare mailbox UUID or IMAP account ID
    ingest_method TEXT NOT NULL DEFAULT 'forward', -- forward | imap | mx
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(customer_id, email_address)
);

-- Email classifications
CREATE TABLE IF NOT EXISTS classifications (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
    message_id TEXT NOT NULL, -- Original Message-ID header
    sender_email TEXT NOT NULL,
    sender_name TEXT,
    subject TEXT,
    category TEXT NOT NULL, -- support | sales | spam | internal | urgent | newsletter | other
    priority TEXT NOT NULL DEFAULT 'P2', -- P0 (critical) | P1 (high) | P2 (normal) | P3 (low)
    sentiment TEXT, -- positive | neutral | negative | frustrated
    entities TEXT, -- JSON: extracted names, companies, products, amounts
    confidence REAL, -- 0.0-1.0 classifier confidence
    llm_model TEXT,
    llm_cost_usd REAL,
    raw_response TEXT, -- Full LLM response for debugging
    classified_at TEXT DEFAULT (datetime('now'))
);

-- AI-generated draft replies
CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    classification_id TEXT NOT NULL REFERENCES classifications(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | edited | sent
    draft_text TEXT NOT NULL,
    suggested_subject TEXT,
    tone TEXT DEFAULT 'professional', -- professional | friendly | urgent | apologetic
    kb_sources_used TEXT, -- JSON array of KB doc IDs referenced
    human_edited_text TEXT, -- If user modified before approving
    approved_by TEXT, -- User email who approved
    approved_at TEXT,
    sent_at TEXT,
    sent_message_id TEXT, -- Message-ID of sent reply
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Routing rules per customer
CREATE TABLE IF NOT EXISTS routing_rules (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    rule_type TEXT NOT NULL, -- category | sender | keyword | priority
    rule_value TEXT NOT NULL, -- e.g., 'support', '@gmail.com', 'invoice', 'P0'
    action TEXT NOT NULL, -- route_to_mailbox | tag | archive | alert | auto_reply
    action_value TEXT, -- target mailbox, tag name, alert channel
    is_active INTEGER DEFAULT 1,
    priority_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Knowledge base documents per customer
CREATE TABLE IF NOT EXISTS kb_documents (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_key TEXT NOT NULL, -- R2 object key
    chunk_count INTEGER DEFAULT 0,
    indexed_at TEXT,
    uploaded_at TEXT DEFAULT (datetime('now'))
);

-- KB chunks for RAG retrieval
CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES kb_documents(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    chunk_index INTEGER NOT NULL,
    text_content TEXT NOT NULL,
    embedding BLOB, -- Vector embedding (if using vector search)
    token_count INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Audit log for compliance and debugging
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    action TEXT NOT NULL, -- classify | draft | approve | reject | send | route | kb_upload
    resource_type TEXT, -- email | draft | rule | kb_document
    resource_id TEXT,
    actor TEXT, -- system | user_email
    details TEXT, -- JSON payload
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Usage tracking for billing
CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    event_type TEXT NOT NULL, -- email_classified | draft_generated | email_sent | kb_query
    quantity INTEGER DEFAULT 1,
    metadata TEXT, -- JSON
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_classifications_customer ON classifications(customer_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS idx_classifications_category ON classifications(category, priority);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_customer ON drafts(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_mailboxes_customer ON mailboxes(customer_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_customer ON kb_chunks(customer_id);
CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_customer ON audit_log(customer_id, created_at DESC);
