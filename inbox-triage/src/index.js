/**
 * EdgeIQ Inbox Triage - Main Worker Entry Point
 */

import { handleWebhook } from './api/webhook.js';
import { handleDrafts } from './api/drafts.js';
import { handleClassify } from './api/classify.js';
import { handleKBUpload } from './api/kb-upload.js';
import { handleStripeWebhook } from './api/stripe-webhook.js';
import { resetMonthlyUsage } from './lib/stripe.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Inbound email webhook from Mailflare
      if (path === '/webhook/email' && request.method === 'POST') {
        return addCors(await handleWebhook(request, env));
      }

      // Stripe subscription webhook
      if (path === '/webhook/stripe' && request.method === 'POST') {
        return addCors(await handleStripeWebhook(request, env));
      }

      // Auth-gated API routes
      if (path.startsWith('/api/')) {
        const authHeader = request.headers.get('Authorization');
        let customerId = null;

        // Skip auth for checkout redirect (public)
        if (path.startsWith('/api/inbox-triage/checkout')) {
          return addCors(await handleCheckoutRedirect(request, env));
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return addCors(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
        }

        // Resolve customer from API key (stored in KV or DB)
        const token = authHeader.replace('Bearer ', '');
        const custData = await env.CACHE_KV.get(`apikey:${token}`);
        if (custData) {
          customerId = custData;
        } else {
          // Fallback: look up by email in DB
          const customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind(token).first();
          if (customer) customerId = customer.id;
        }

        if (!customerId) {
          return addCors(new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
        }

        // Route to handlers
        if (path === '/api/drafts' || path.match(/\/api\/drafts\//)) {
          return addCors(await handleDrafts(path, request, env, customerId));
        }
        if (path === '/api/classify') {
          return addCors(await handleClassify(path, request, env, customerId));
        }
        if (path === '/api/kb/upload') {
          return addCors(await handleKBUpload(request, env, customerId));
        }
        if (path === '/api/stats') {
          return addCors(await handleStats(env, customerId));
        }

        return addCors(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }

      // Health check
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'inbox-triage', version: '0.1.0' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // Landing page
      if (path === '/' || path === '/inbox-triage' || path === '/inbox-triage/') {
        return new Response('Inbox Triage by EdgeIQ Labs — Redirect to landing page', {
          status: 302,
          headers: { 'Location': '/inbox-triage/', ...corsHeaders() }
        });
      }

      // Dashboard SPA
      if (path.startsWith('/dashboard')) {
        return new Response(`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Inbox Triage Dashboard — EdgeIQ Labs</title>
  <link rel="stylesheet" href="/css/design-system.css?v=10">
  <script src="/js/theme.js"></script>
  <style>
    .dash-layout { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 64px); }
    .dash-sidebar { background: var(--color-bg-surface); border-right: 1px solid var(--color-border); padding: 24px 0; }
    .dash-sidebar a { display: block; padding: 10px 24px; color: var(--color-text-secondary); text-decoration: none; font-size: 0.95rem; transition: all 0.15s; }
    .dash-sidebar a:hover, .dash-sidebar a.active { color: var(--color-accent); background: rgba(61,217,255,0.06); border-left: 3px solid var(--color-accent); }
    .dash-main { padding: 32px; overflow-y: auto; }
    .dash-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
    .dash-header h1 { font-size: 1.5rem; margin: 0; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20px; }
    .stat-card .label { font-size: 0.8rem; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .stat-card .value { font-size: 1.8rem; font-weight: 800; color: var(--color-accent); }
    .draft-list { list-style: none; padding: 0; margin: 0; }
    .draft-item { background: var(--color-bg-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 16px 20px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
    .draft-meta { font-size: 0.85rem; color: var(--color-text-secondary); }
    .draft-actions { display: flex; gap: 8px; }
    .draft-actions button { padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
    .btn-approve { background: #00c853; color: #071018; }
    .btn-reject { background: #ff1744; color: white; }
    .btn-edit { background: transparent; border: 1px solid var(--color-border) !important; color: var(--color-text-primary); }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 700; }
    .badge-p0 { background: #ff1744; color: white; }
    .badge-p1 { background: #ff9100; color: #071018; }
    .badge-p2 { background: var(--color-accent); color: #071018; }
    .badge-p3 { background: var(--color-border); color: var(--color-text-secondary); }
    .badge-support { background: #2979ff; color: white; }
    .badge-sales { background: #00c853; color: #071018; }
    .badge-spam { background: #424242; color: #aaa; }
    .empty-state { text-align: center; padding: 60px 20px; color: var(--color-text-secondary); }
    @media (max-width: 768px) {
      .dash-layout { grid-template-columns: 1fr; }
      .dash-sidebar { display: none; }
    }
  </style>
</head>
<body>
  <nav class="nav-bar">
    <div class="nav-inner">
      <a class="nav-brand" href="/">
        <img class="nav-logo-img" src="/logo-edgeiq-selected.png" alt="EdgeIQ Labs logo" />
        <div class="nav-wordmark">
          <div class="nav-brand-name">Edge<span>IQ</span> Labs</div>
          <div class="nav-brand-tag">Inbox Triage</div>
        </div>
      </a>
      <div class="nav-links">
        <a href="/dashboard/" style="color:var(--color-accent);font-weight:600;">Dashboard</a>
        <button id="logout-btn" class="nav-cta" style="background:transparent;border:1px solid var(--color-border);color:var(--color-text-primary);cursor:pointer;">Logout</button>
      </div>
    </div>
  </nav>

  <div class="dash-layout">
    <aside class="dash-sidebar">
      <a href="#overview" class="active" onclick="switchTab('overview')">📊 Overview</a>
      <a href="#drafts" onclick="switchTab('drafts')">✏️ Draft Queue</a>
      <a href="#classified" onclick="switchTab('classified')">📧 Classified</a>
      <a href="#rules" onclick="switchTab('rules')">⚙️ Routing Rules</a>
      <a href="#kb" onclick="switchTab('kb')">📚 Knowledge Base</a>
      <a href="#settings" onclick="switchTab('settings')">🔧 Settings</a>
    </aside>

    <main class="dash-main" id="dash-content">
      <!-- Content injected by JS -->
    </main>
  </div>

  <script>
    const API = '/api';
    let token = localStorage.getItem('triage_token') || '';

    if (!token) {
      document.getElementById('dash-content').innerHTML = \`
        <div class="empty-state">
          <h2>Sign in to your dashboard</h2>
          <p>Enter your API key to access Inbox Triage.</p>
          <input type="password" id="api-key-input" placeholder="Your API key" style="padding:10px 16px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-bg-surface);color:var(--color-text-primary);width:300px;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto;">
          <button onclick="login()" class="btn btn-primary" style="padding:10px 24px;border-radius:8px;border:none;cursor:pointer;font-weight:700;">Sign In</button>
        </div>\`;
    } else {
      loadOverview();
    }

    function login() {
      token = document.getElementById('api-key-input').value;
      localStorage.setItem('triage_token', token);
      location.reload();
    }

    document.getElementById('logout-btn')?.addEventListener('click', () => {
      localStorage.removeItem('triage_token');
      location.reload();
    });

    async function api(path, opts = {}) {
      const res = await fetch(API + path, {
        ...opts,
        headers: { 'Authorization': \`Bearer \${token}\`, 'Content-Type': 'application/json', ...opts.headers }
      });
      return res.json();
    }

    function switchTab(tab) {
      document.querySelectorAll('.dash-sidebar a').forEach(a => a.classList.remove('active'));
      document.querySelector(\`.dash-sidebar a[href="#\${tab}"]\`)?.classList.add('active');
      const loaders = { overview: loadOverview, drafts: loadDrafts, classified: loadClassified, rules: loadRules, kb: loadKB, settings: loadSettings };
      (loaders[tab] || loadOverview)();
    }

    async function loadOverview() {
      const el = document.getElementById('dash-content');
      el.innerHTML = \`<div class="dash-header"><h1>Overview</h1><span style="color:var(--color-text-secondary);font-size:0.9rem;">Last 30 days</span></div>
        <div class="stat-grid">
          <div class="stat-card"><div class="label">Emails Triaged</div><div class="value" id="stat-total">—</div></div>
          <div class="stat-card"><div class="label">Drafts Pending</div><div class="value" id="stat-drafts">—</div></div>
          <div class="stat-card"><div class="label">P0 Alerts</div><div class="value" id="stat-p0" style="color:#ff1744;">—</div></div>
          <div class="stat-card"><div class="label">Avg Confidence</div><div class="value" id="stat-conf">—</div></div>
        </div>
        <h3 style="margin-bottom:16px;">Recent Classifications</h3>
        <ul class="draft-list" id="recent-list"><li class="empty-state">Loading...</li></ul>\`;
      try {
        const data = await api('/stats');
        if (data.stats) {
          document.getElementById('stat-total').textContent = data.stats.total || 0;
          document.getElementById('stat-drafts').textContent = data.stats.pendingDrafts || 0;
          document.getElementById('stat-p0').textContent = data.stats.p0Count || 0;
          document.getElementById('stat-conf').textContent = data.stats.avgConfidence ? (data.stats.avgConfidence * 100).toFixed(0) + '%' : '—';
        }
        if (data.recent) {
          document.getElementById('recent-list').innerHTML = data.recent.map(c => \`
            <li class="draft-item">
              <div><strong>\${esc(c.sender_email)}</strong><br><span class="draft-meta">\${esc(c.subject || '(no subject)')}</span></div>
              <div><span class="badge badge-\${c.category}">\${c.category}</span> <span class="badge badge-\${c.priority.toLowerCase()}">\${c.priority}</span></div>
            </li>\`).join('');
        }
      } catch(e) { console.error(e); }
    }

    async function loadDrafts() {
      const el = document.getElementById('dash-content');
      el.innerHTML = \`<div class="dash-header"><h1>Draft Queue</h1></div><ul class="draft-list" id="draft-list"><li class="empty-state">Loading...</li></ul>\`;
      try {
        const data = await api('/drafts?status=pending');
        if (!data.drafts?.length) { el.querySelector('#draft-list').innerHTML = '<li class="empty-state">No pending drafts. AI replies appear here for your review.</li>'; return; }
        el.querySelector('#draft-list').innerHTML = data.drafts.map(d => \`
          <li class="draft-item">
            <div style="flex:1;">
              <strong>To: \${esc(d.sender_email || 'unknown')}</strong><br>
              <span class="draft-meta">Re: \${esc(d.original_subject || '')}</span>
              <p style="margin:8px 0 0;color:var(--color-text-secondary);font-size:0.9rem;">\${esc((d.draft_text||'').substring(0,200))}...</p>
            </div>
            <div class="draft-actions">
              <button class="btn-edit" onclick="editDraft('\${d.id}')">Edit</button>
              <button class="btn-reject" onclick="rejectDraft('\${d.id}')">Reject</button>
              <button class="btn-approve" onclick="approveDraft('\${d.id}')">Approve & Send</button>
            </div>
          </li>\`).join('');
      } catch(e) { console.error(e); }
    }

    async function approveDraft(id) { await api(\`/drafts/\${id}/approve\`, { method: 'POST' }); loadDrafts(); }
    async function rejectDraft(id) { await api(\`/drafts/\${id}/reject\`, { method: 'POST' }); loadDrafts(); }
    function editDraft(id) { alert('Inline editor coming soon. Use API PUT /drafts/:id/edit for now.'); }

    async function loadClassified() {
      document.getElementById('dash-content').innerHTML = \`<div class="dash-header"><h1>Classified Emails</h1></div><p style="color:var(--color-text-secondary);">Full classification history with search and filters. Coming in v0.2.</p>\`;
    }
    async function loadRules() {
      document.getElementById('dash-content').innerHTML = \`<div class="dash-header"><h1>Routing Rules</h1></div><p style="color:var(--color-text-secondary);">Create custom rules to route emails by sender, keyword, category, or priority. Coming in v0.2.</p>\`;
    }
    async function loadKB() {
      const el = document.getElementById('dash-content');
      el.innerHTML = \`<div class="dash-header"><h1>Knowledge Base</h1></div>
        <p style="color:var(--color-text-secondary);margin-bottom:24px;">Upload documents that the AI uses to draft contextual replies.</p>
        <form id="kb-upload" style="background:var(--color-bg-surface);border:2px dashed var(--color-border);border-radius:var(--radius-lg);padding:40px;text-align:center;">
          <input type="file" id="kb-file" accept=".pdf,.txt,.md,.html" style="margin-bottom:16px;">
          <br><button type="submit" class="btn btn-primary" style="padding:10px 24px;border-radius:8px;border:none;cursor:pointer;font-weight:700;">Upload Document</button>
        </form>
        <div id="kb-list" style="margin-top:24px;"></div>\`;
      document.getElementById('kb-upload').addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = document.getElementById('kb-file').files[0];
        if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        await fetch(API + '/kb/upload', { method: 'POST', headers: { 'Authorization': \`Bearer \${token}\` }, body: fd });
        alert('Uploaded successfully!');
      });
    }
    async function loadSettings() {
      document.getElementById('dash-content').innerHTML = \`<div class="dash-header"><h1>Settings</h1></div><p style="color:var(--color-text-secondary);">Mailbox connections, notification preferences, billing management. Coming in v0.2.</p>\`;
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8', ...corsHeaders() } });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders() });

    } catch (err) {
      console.error('Worker error:', err.stack || err.message);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(resetMonthlyUsage(env));
  }
};

async function handleStats(env, customerId) {
  const total = await env.DB.prepare('SELECT COUNT(*) as count FROM classifications WHERE customer_id = ?').bind(customerId).first();
  const pending = await env.DB.prepare("SELECT COUNT(*) as count FROM drafts WHERE customer_id = ? AND status = 'pending'").bind(customerId).first();
  const p0 = await env.DB.prepare("SELECT COUNT(*) as count FROM classifications WHERE customer_id = ? AND priority = 'P0'").bind(customerId).first();
  const avgConf = await env.DB.prepare('SELECT AVG(confidence) as avg FROM classifications WHERE customer_id = ?').bind(customerId).first();
  const recent = await env.DB.prepare('SELECT sender_email, subject, category, priority, classified_at FROM classifications WHERE customer_id = ? ORDER BY classified_at DESC LIMIT 10').bind(customerId).all();

  return new Response(JSON.stringify({
    stats: {
      total: total?.count || 0,
      pendingDrafts: pending?.count || 0,
      p0Count: p0?.count || 0,
      avgConfidence: avgConf?.avg || 0
    },
    recent: recent.results || []
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCheckoutRedirect(request, env) {
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'starter';
  const priceMap = { starter: 'price_1UY6wJRC1NZ20yDTDwJKHkoY', pro: 'price_1UY6wKRC1NZ20yDTv82U7JIC' };

  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Checkout not configured' }), { status: 501 });
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': priceMap[plan] || priceMap.starter,
        'line_items[0][quantity]': '1',
        success_url: `${url.origin}/dashboard/?checkout=success`,
        cancel_url: `${url.origin}/inbox-triage/?checkout=cancelled`,
        'metadata[plan]': plan
      }).toString()
    });

    const session = await response.json();
    if (session.url) {
      return new Response(null, { status: 302, headers: { 'Location': session.url } });
    }
    return new Response(JSON.stringify({ error: 'Failed to create checkout' }), { status: 500 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function addCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
