/**
 * EdgeIQ StatusPage API — CRUD for pages, components, incidents, subscribers
 * Routes: /api/statuspage/*
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

function generateId() {
  return crypto.randomUUID();
}

// Auth: simple API key check against KV
async function authenticate(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const key = auth.slice(7);
  // Check if key maps to a valid page owner
  const page = await env.STATUSPAGE_DB.prepare(
    'SELECT * FROM pages WHERE id = (SELECT page_id FROM api_keys WHERE key = ?)'
  ).bind(key).first();
  return page || null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/statuspage', '');
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // ── Pages ──
    if (path === '/pages' && method === 'POST') {
      const body = await request.json();
      const { name, slug, description, owner_email } = body;
      if (!name || !slug || !owner_email) return error('name, slug, and owner_email required');
      
      const id = generateId();
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO pages (id, slug, name, description, owner_email, tier) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, slug, name, description || '', owner_email, 'starter').run();
      
      return json({ id, slug, name }, 201);
    }

    if (path === '/pages' && method === 'GET') {
      const email = url.searchParams.get('email');
      if (!email) return error('email parameter required');
      const pages = await env.STATUSPAGE_DB.prepare(
        'SELECT id, slug, name, description, tier, custom_domain, created_at FROM pages WHERE owner_email = ? ORDER BY created_at DESC'
      ).bind(email).all();
      return json(pages.results || []);
    }

    // ── Components ──
    if (path.match(/^\/pages\/[^/]+\/components$/) && method === 'POST') {
      const pageSlug = path.split('/')[2];
      const body = await request.json();
      const { name, description, group_name } = body;
      if (!name) return error('name required');
      
      const page = await env.STATUSPAGE_DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(pageSlug).first();
      if (!page) return error('page not found', 404);
      
      const id = generateId();
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO components (id, page_id, name, description, group_name) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, page.id, name, description || '', group_name || null).run();
      
      return json({ id, name }, 201);
    }

    if (path.match(/^\/pages\/[^/]+\/components$/) && method === 'GET') {
      const pageSlug = path.split('/')[2];
      const components = await env.STATUSPAGE_DB.prepare(
        'SELECT c.*, COALESCE(uh.avg_response_ms, 0) as avg_response_ms FROM components c LEFT JOIN (SELECT component_id, AVG(avg_response_ms) as avg_response_ms FROM uptime_history WHERE date >= date("now", "-30 days") GROUP BY component_id) uh ON c.id = uh.component_id WHERE c.page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY c.sort_order, c.name'
      ).bind(pageSlug).all();
      return json(components.results || []);
    }

    // ── Incidents ──
    if (path.match(/^\/pages\/[^/]+\/incidents$/) && method === 'POST') {
      const pageSlug = path.split('/')[2];
      const body = await request.json();
      const { title, status, severity, body: incidentBody, affected_components } = body;
      if (!title) return error('title required');
      
      const page = await env.STATUSPAGE_DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(pageSlug).first();
      if (!page) return error('page not found', 404);
      
      const id = generateId();
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO incidents (id, page_id, title, status, severity, body, affected_components) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, page.id, title, status || 'investigating', severity || 'minor', incidentBody || '', JSON.stringify(affected_components || [])).run();
      
      // Create initial update
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO incident_updates (id, incident_id, status, body) VALUES (?, ?, ?, ?)'
      ).bind(generateId(), id, status || 'investigating', incidentBody || 'Incident reported.').run();
      
      return json({ id, title }, 201);
    }

    if (path.match(/^\/pages\/[^/]+\/incidents$/) && method === 'GET') {
      const pageSlug = path.split('/')[2];
      const activeOnly = url.searchParams.get('active') !== 'false';
      const query = activeOnly
        ? 'SELECT * FROM incidents WHERE page_id = (SELECT id FROM pages WHERE slug = ?) AND status NOT IN ("resolved", "completed") ORDER BY created_at DESC'
        : 'SELECT * FROM incidents WHERE page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY created_at DESC LIMIT 50';
      const incidents = await env.STATUSPAGE_DB.prepare(query).bind(pageSlug).all();
      return json(incidents.results || []);
    }

    // ── Subscribers ──
    if (path.match(/^\/pages\/[^/]+\/subscribe$/) && method === 'POST') {
      const pageSlug = path.split('/')[2];
      const body = await request.json();
      const { email } = body;
      if (!email) return error('email required');
      
      const page = await env.STATUSPAGE_DB.prepare('SELECT id FROM pages WHERE slug = ?').bind(pageSlug).first();
      if (!page) return error('page not found', 404);
      
      // Check existing
      const existing = await env.STATUSPAGE_DB.prepare(
        'SELECT id FROM subscribers WHERE page_id = ? AND email = ?'
      ).bind(page.id, email).first();
      if (existing) return json({ id: existing.id, message: 'already subscribed' });
      
      const id = generateId();
      const verifyToken = generateId();
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO subscribers (id, page_id, email, verify_token) VALUES (?, ?, ?, ?)'
      ).bind(id, page.id, email, verifyToken).run();
      
      // Send verification email via Resend
      if (env.RESEND_API_KEY) {
        const verifyUrl = `https://edgeiqlabs.com/api/statuspage/verify?token=${verifyToken}`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
            to: [email],
            subject: 'Verify your StatusPage subscription',
            html: `<h2>Confirm your subscription</h2><p>Click below to start receiving status updates:</p><p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#b47aff;color:#071018;border-radius:8px;text-decoration:none;font-weight:700;">Verify Email</a></p><p style="color:#666;font-size:0.85rem;margin-top:16px;">If you didn't request this, ignore this email.</p>`
          })
        });
      }
      
      return json({ id, message: 'verification email sent' }, 201);
    }

    // ── Public status page data ──
    if (path.match(/^\/public\/[^/]+$/) && method === 'GET') {
      const pageSlug = path.split('/')[2];
      const page = await env.STATUSPAGE_DB.prepare(
        'SELECT name, description, theme_color, logo_url, show_uptime_graph FROM pages WHERE slug = ?'
      ).bind(pageSlug).first();
      if (!page) return error('page not found', 404);
      
      const components = await env.STATUSPAGE_DB.prepare(
        'SELECT name, description, group_name, status, uptime_pct FROM components WHERE page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY sort_order, name'
      ).bind(pageSlug).all();
      
      const incidents = await env.STATUSPAGE_DB.prepare(
        'SELECT title, status, severity, body, created_at, resolved_at FROM incidents WHERE page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY created_at DESC LIMIT 20'
      ).bind(pageSlug).all();
      
      return json({
        page,
        components: components.results || [],
        incidents: incidents.results || [],
      });
    }

    return error('not found', 404);
  } catch (e) {
    console.error('StatusPage API error:', e);
    return error(e.message || 'internal error', 500);
  }
}
