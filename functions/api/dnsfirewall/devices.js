/**
 * EdgeIQ DNS Firewall — Device management endpoint
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

    if (request.method === 'POST') {
      const currentDevices = await env.DNSFW_DB.prepare('SELECT COUNT(*) as count FROM dnsfw_devices WHERE customer_id = ?').bind(customer.id).first();
      if (currentDevices.count >= customer.max_devices) {
        return json({ error: `Device limit reached (${customer.max_devices}). Upgrade to add more.` }, 403);
      }
      const body = await request.json();
      const name = (body.name || '').trim();
      if (!name) return json({ error: 'Device name required' });
      const id = crypto.randomUUID();
      const identifier = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20) + '-' + id.slice(0, 8);
      await env.DNSFW_DB.prepare('INSERT INTO dnsfw_devices (id, customer_id, name, identifier) VALUES (?, ?, ?, ?)').bind(id, customer.id, name, identifier).run();
      return json({ id, name, identifier, dns_servers: ['104.21.48.1', '104.21.49.1'] }, 201);
    }

    if (request.method === 'DELETE') {
      const deviceId = url.searchParams.get('id');
      if (!deviceId) return json({ error: 'Device ID required' });
      await env.DNSFW_DB.prepare('DELETE FROM dnsfw_devices WHERE id = ? AND customer_id = ?').bind(deviceId, customer.id).run();
      return json({ success: true });
    }

    // GET: list devices
    const devices = await env.DNSFW_DB.prepare('SELECT * FROM dnsfw_devices WHERE customer_id = ?').bind(customer.id).all();
    return json({ devices: devices.results || [] });
  } catch (e) {
    console.error('DNSFW devices error:', e);
    return json({ error: 'Internal error' }, 500);
  }
}
