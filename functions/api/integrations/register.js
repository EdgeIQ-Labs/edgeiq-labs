// POST /api/integrations/register
// Body: { email, domain, webhooks: [{type, url}], plan }
// Saves webhook config to PULSE_KV under key `webhooks:{email}:{domain}`

export async function onRequestPost({ request, env }) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const plan = (body.plan || 'free').trim().toLowerCase();

  if (!email || !email.includes('@')) return json({ error: 'Valid email required' }, 400);
  if (!domain) return json({ error: 'Domain required' }, 400);

  const webhooks = Array.isArray(body.webhooks) ? body.webhooks : [];

  if (plan === 'free' && webhooks.length > 0) {
    return json({ error: 'Webhook integrations require Integrations Pro. Upgrade at https://buy.stripe.com/28E8wR3XJ6d71bK3gk7wA3t' }, 403);
  }

  const MAX_WEBHOOKS = 3;
  const validTypes = ['slack', 'discord', 'teams', 'webhook', 'all'];
  const validated = webhooks.slice(0, MAX_WEBHOOKS).filter(w => {
    if (!w.url || !w.url.startsWith('https://')) return false;
    if (!validTypes.includes(w.type)) return false;
    return true;
  });

  const key = `webhooks:${email}:${domain}`;
  const record = {
    email,
    domain,
    plan,
    webhooks: validated,
    registered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await env.PULSE_KV.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 });

  return json({ ok: true, registered: validated.length, domain, email });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
