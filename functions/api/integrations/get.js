// GET /api/integrations/get?email=...&domain=...
// Returns the current webhook config for an email+domain pair

export async function onRequestGet({ request, env }) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

  if (!email || !email.includes('@')) return json({ error: 'Valid email required' }, 400);
  if (!domain) return json({ error: 'Domain required' }, 400);

  const key = `webhooks:${email}:${domain}`;
  const raw = await env.PULSE_KV.get(key);
  if (!raw) return json({ found: false, webhooks: [] });

  let record;
  try { record = JSON.parse(raw); } catch { return json({ error: 'Corrupt record' }, 500); }

  return json({
    found: true,
    email: record.email,
    domain: record.domain,
    plan: record.plan,
    webhooks: record.webhooks || [],
    registered_at: record.registered_at,
    updated_at: record.updated_at,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
