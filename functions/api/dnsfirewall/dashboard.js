/**
 * EdgeIQ DNS Firewall — Dashboard stats endpoint
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

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || request.headers.get('X-DNSFW-Email') || '').toLowerCase().trim();
  if (!email) return json({ error: 'Email required' }, 401);
  if (!env.DNSFW_DB) return json({ error: 'Database not configured' }, 500);

  try {
    const customer = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_customers WHERE email = ?').bind(email).first();
    if (!customer) return json({ error: 'Customer not found' }, 404);

    const devices = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_devices WHERE customer_id = ?').bind(customer.id).all();
    const blocklists = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_blocklists WHERE customer_id = ? ORDER BY category, name').bind(customer.id).all();
    const stats = await env.DNSFW_DB.prepare('SELECT SUM(total_queries) as total, SUM(blocked_queries) as blocked FROM dnsfw_stats_hourly WHERE customer_id = ? AND hour >= strftime("%Y-%m-%d-%H", datetime("now", "-24 hours"))').bind(customer.id).first();
    const alerts = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_alerts WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10').bind(customer.id).all();

    return json({
      customer,
      devices: devices.results || [],
      blocklists: blocklists.results || [],
      stats: { total_queries: stats?.total || 0, blocked_queries: stats?.blocked || 0 },
      alerts: alerts.results || [],
    });
  } catch (e) {
    console.error('DNSFW dashboard error:', e);
    return json({ error: 'Internal error' }, 500);
  }
}
