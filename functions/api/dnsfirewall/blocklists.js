/**
 * EdgeIQ DNS Firewall — Blocklist management endpoint
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!env.DNSFW_DB) return json({ error: 'Database not configured' }, 500);

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || request.headers.get('X-DNSFW-Email') || '').toLowerCase().trim();
  if (!email) return json({ error: 'Email required' }, 401);

  try {
    const customer = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_customers WHERE email = ?').bind(email).first();
    if (!customer) return json({ error: 'Customer not found' }, 404);

    if (request.method === 'GET') {
      const lists = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_blocklists WHERE customer_id = ? ORDER BY category, name').bind(customer.id).all();
      return json({ blocklists: lists.results || [] });
    }

    if (request.method === 'POST') {
      const currentLists = await env.DNSFW_DB.prepare('SELECT COUNT(*) as count FROM dnsfw_blocklists WHERE customer_id = ?').bind(customer.id).first();
      if (currentLists.count >= customer.max_blocklists) {
        return json({ error: `Blocklist limit reached (${customer.max_blocklists}). Upgrade to add more.` }, 403);
      }
      const body = await request.json();
      const name = (body.name || '').trim();
      const category = (body.category || 'custom').trim();
      const sourceUrl = (body.source_url || '').trim();
      if (!name) return json({ error: 'Blocklist name required' });
      const id = crypto.randomUUID();
      await env.DNSFW_DB.prepare('INSERT INTO dnsfw_blocklists (id, customer_id, name, category, source_url) VALUES (?, ?, ?, ?, ?)').bind(id, customer.id, name, category, sourceUrl || null).run();
      return json({ id, name, category, source_url: sourceUrl }, 201);
    }

    if (request.method === 'DELETE') {
      const listId = url.searchParams.get('id');
      if (!listId) return json({ error: 'Blocklist ID required' });
      await env.DNSFW_DB.prepare('DELETE FROM dnsfw_blocklists WHERE id = ? AND customer_id = ?').bind(listId, customer.id).run();
      return json({ success: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('DNSFW blocklists error:', e);
    return json({ error: 'Internal error' }, 500);
  }
}
