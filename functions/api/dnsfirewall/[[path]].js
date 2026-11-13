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

  // Debug: log path for troubleshooting
  if (path.includes('sync')) {
    console.log('DNSFW ROUTER DEBUG:', { pathname: url.pathname, extractedPath: path, method });
  }

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

    // ── Pi-hole sync (cron or manual) ──
    if (path === '/sync-pihole' && (method === 'GET' || method === 'POST')) {
      // Auth gate for POST
      if (method === 'POST') {
        const key = request.headers.get('X-Internal-Key');
        const expected = env.DNSFW_INTERNAL_KEY || '3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
        if (key !== expected) return error('Unauthorized', 401);
      }

      const PIHOLES = [
        { name: 'PH1', url: 'http://10.5.1.117', password: 'admin' },
        { name: 'PH2', url: 'http://10.5.1.240', password: 'admin' },
      ];

      async function phAuth(baseUrl, pw) {
        const r = await fetch(`${baseUrl}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
        const d = await r.json();
        return d?.session?.sid || null;
      }
      async function phGet(url, sid) { return (await fetch(url, { headers: { 'X-FTL-SID': sid } })).json(); }
      async function phPost(url, sid, body) { return (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid }, body: JSON.stringify(body) })).json(); }
      async function phPut(url, sid, body) { return (await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid }, body: JSON.stringify(body) })).json(); }

      const customers = await env.DNSFW_DB.prepare("SELECT id, email, tier FROM dnsfw_customers WHERE tier != 'free'").all();
      if (!customers.results || customers.results.length === 0) {
        return json({ success: true, message: 'No active customers', synced: 0 });
      }

      const results = [];
      for (const cust of customers.results) {
        const bls = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_blocklists WHERE customer_id = ? AND enabled = 1').bind(cust.id).all();
        const cResult = { customerId: cust.id, piholeResults: {} };

        for (const ph of PIHOLES) {
          try {
            const sid = await phAuth(ph.url, ph.password);
            if (!sid) { cResult.piholeResults[ph.name] = { error: 'Auth failed' }; continue; }

            const groupName = `dnsfw_${cust.id}`;
            const groups = await phGet(`${ph.url}/api/groups`, sid);
            let groupId = (groups.groups || []).find(g => g.name === groupName)?.id;
            if (!groupId) {
              await phPost(`${ph.url}/api/groups`, sid, { name: groupName, comment: 'DNSFW customer', enabled: true });
              const refreshed = await phGet(`${ph.url}/api/groups`, sid);
              groupId = (refreshed.groups || []).find(g => g.name === groupName)?.id;
            }
            if (!groupId) { cResult.piholeResults[ph.name] = { error: 'Group creation failed' }; continue; }

            const currentLists = await phGet(`${ph.url}/api/lists`, sid);
            const currentAdlists = (currentLists.lists || []).filter(l => l.type === 'block');
            let added = 0, skipped = 0;

            for (const bl of (bls.results || [])) {
              if (!bl.source_url || !bl.enabled) continue;
              const existing = currentAdlists.find(l => l.address === bl.source_url);
              if (existing) {
                if (!existing.groups.includes(groupId)) {
                  await phPut(`${ph.url}/api/lists/${encodeURIComponent(bl.source_url)}`, sid, { groups: [...existing.groups, groupId], enabled: true });
                }
                skipped++;
              } else {
                await phPost(`${ph.url}/api/lists`, sid, { address: bl.source_url, type: 'block', comment: `DNSFW ${cust.id}: ${bl.name}`, groups: [groupId], enabled: true });
                added++;
              }
            }
            cResult.piholeResults[ph.name] = { groupId, added, skipped };
          } catch (e) { cResult.piholeResults[ph.name] = { error: e.message }; }
        }
        results.push(cResult);
      }

      // Trigger gravity
      const gravity = {};
      for (const ph of PIHOLES) {
        try {
          const sid = await phAuth(ph.url, ph.password);
          if (sid) { await phPost(`${ph.url}/api/action/gravity`, sid, {}); gravity[ph.name] = 'triggered'; }
        } catch (e) { gravity[ph.name] = e.message; }
      }

      return json({ success: true, synced: results.length, customers: results, gravity, timestamp: new Date().toISOString() });
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
