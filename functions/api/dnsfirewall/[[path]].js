/**
 * EdgeIQ DNS Firewall — Main API Router
 * Handles: dashboard data, device management, blocklist config, query logs
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!env.DNSFW_DB) {
    return error('Database not configured', 500);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace('/api/dnsfirewall', '') || '/';
  const method = request.method;

  // Auth: extract email from query param or header (simple auth for MVP)
  const email = (url.searchParams.get('email') || request.headers.get('X-DNSFW-Email') || '').toLowerCase().trim();

  try {
    // ── Dashboard stats ──
    if (path === '/dashboard' && method === 'GET') {
      if (!email) return error('Email required', 401);

      const customer = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      const devices = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_devices WHERE customer_id = ?'
      ).bind(customer.id).all();

      const blocklists = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_blocklists WHERE customer_id = ? ORDER BY category, name'
      ).bind(customer.id).all();

      // Last 24h stats
      const stats = await env.DNSFW_DB.prepare(
        'SELECT SUM(total_queries) as total, SUM(blocked_queries) as blocked FROM dnsfw_stats_hourly WHERE customer_id = ? AND hour >= strftime("%Y-%m-%d-%H", datetime("now", "-24 hours"))'
      ).bind(customer.id).first();

      // Recent alerts
      const alerts = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_alerts WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10'
      ).bind(customer.id).all();

      return json({
        customer,
        devices: devices.results || [],
        blocklists: blocklists.results || [],
        stats: { total_queries: stats?.total || 0, blocked_queries: stats?.blocked || 0 },
        alerts: alerts.results || [],
      });
    }

    // ── Device management ──
    if (path === '/devices' && method === 'POST') {
      if (!email) return error('Email required', 401);
      const customer = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      const currentDevices = await env.DNSFW_DB.prepare(
        'SELECT COUNT(*) as count FROM dnsfw_devices WHERE customer_id = ?'
      ).bind(customer.id).first();
      if (currentDevices.count >= customer.max_devices) {
        return error(`Device limit reached (${customer.max_devices}). Upgrade to add more.`, 403);
      }

      const body = await request.json();
      const name = (body.name || '').trim();
      if (!name) return error('Device name required');

      const id = crypto.randomUUID();
      const identifier = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20) + '-' + id.slice(0, 8);

      await env.DNSFW_DB.prepare(
        'INSERT INTO dnsfw_devices (id, customer_id, name, identifier) VALUES (?, ?, ?, ?)'
      ).bind(id, customer.id, name, identifier).run();

      return json({ id, name, identifier, dns_servers: ['104.21.48.1', '104.21.49.1'] }, 201);
    }

    if (path.match(/^\/devices\/[\w-]+$/) && method === 'DELETE') {
      if (!email) return error('Email required', 401);
      const deviceId = path.split('/')[2];
      const customer = await env.DNSFW_DB.prepare(
        'SELECT id FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      await env.DNSFW_DB.prepare(
        'DELETE FROM dnsfw_devices WHERE id = ? AND customer_id = ?'
      ).bind(deviceId, customer.id).run();

      return json({ success: true });
    }

    // ── Blocklist management ──
    if (path === '/blocklists' && method === 'GET') {
      if (!email) return error('Email required', 401);
      const customer = await env.DNSFW_DB.prepare(
        'SELECT id FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      const lists = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_blocklists WHERE customer_id = ? ORDER BY category, name'
      ).bind(customer.id).all();

      return json({ blocklists: lists.results || [] });
    }

    if (path === '/blocklists' && method === 'POST') {
      if (!email) return error('Email required', 401);
      const customer = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      const currentLists = await env.DNSFW_DB.prepare(
        'SELECT COUNT(*) as count FROM dnsfw_blocklists WHERE customer_id = ?'
      ).bind(customer.id).first();
      if (currentLists.count >= customer.max_blocklists) {
        return error(`Blocklist limit reached (${customer.max_blocklists}). Upgrade to add more.`, 403);
      }

      const body = await request.json();
      const name = (body.name || '').trim();
      const category = (body.category || 'custom').trim();
      const sourceUrl = (body.source_url || '').trim();

      if (!name) return error('Blocklist name required');

      const id = crypto.randomUUID();
      await env.DNSFW_DB.prepare(
        'INSERT INTO dnsfw_blocklists (id, customer_id, name, category, source_url) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, customer.id, name, category, sourceUrl || null).run();

      return json({ id, name, category, source_url: sourceUrl }, 201);
    }

    // ── Query log ──
    if (path === '/queries' && method === 'GET') {
      if (!email) return error('Email required', 401);
      const customer = await env.DNSFW_DB.prepare(
        'SELECT id FROM dnsfw_customers WHERE email = ?'
      ).bind(email).first();
      if (!customer) return error('Customer not found', 404);

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const queries = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_queries WHERE customer_id = ? ORDER BY queried_at DESC LIMIT ? OFFSET ?'
      ).bind(customer.id, limit, offset).all();

      return json({ queries: queries.results || [] });
    }

    // ── Public info endpoint ──
    if (path === '/' && method === 'GET') {
      return json({
        service: 'DNS Firewall',
        description: 'Managed DNS filtering with threat intelligence',
        tiers: {
          free: { price: '$0/mo', devices: 1, blocklists: 3, features: ['Basic ad blocking'] },
          personal: { price: '$5/mo', devices: 10, blocklists: 10, features: ['Malware/phishing protection', 'Custom allowlists', 'Weekly digest'] },
          business: { price: '$19/mo', devices: 'Unlimited', blocklists: 'Unlimited', features: ['Real-time alerts', 'Compliance reporting', 'Priority support'] },
        },
      });
    }

    return error('Not found', 404);
  } catch (e) {
    console.error('DNSFirewall API error:', e);
    return error('Internal error', 500);
  }
}
