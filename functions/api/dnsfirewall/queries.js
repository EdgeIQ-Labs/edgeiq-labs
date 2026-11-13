/**
 * EdgeIQ DNS Firewall — Query log endpoint
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.DNSFW_DB) return json({ error: 'Database not configured' }, 500);

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || request.headers.get('X-DNSFW-Email') || '').toLowerCase().trim();
  if (!email) return json({ error: 'Email required' }, 401);

  try {
    const customer = await env.DNSFW_DB.prepare('SELECT id FROM dnsfw_customers WHERE email = ?').bind(email).first();
    if (!customer) return json({ error: 'Customer not found' }, 404);

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const queries = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_queries WHERE customer_id = ? ORDER BY queried_at DESC LIMIT ? OFFSET ?').bind(customer.id, limit, offset).all();

    return json({ queries: queries.results || [] });
  } catch (e) {
    console.error('DNSFW queries error:', e);
    return json({ error: 'Internal error' }, 500);
  }
}
