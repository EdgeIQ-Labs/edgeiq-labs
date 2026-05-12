/**
 * POST /api/vendor-watch-signup
 * Body: { email, vendors: ['stripe','github',...], plan }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const vendors = Array.isArray(body.vendors) ? body.vendors.slice(0, 20) : [];
  const plan = (body.plan || 'free').trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);
  if (!['free', 'pro'].includes(plan)) return json({ error: 'Invalid plan' }, 400);

  const subscriber = {
    email, vendors, plan,
    product: 'vendor-watch',
    created_at: new Date().toISOString(),
    last_check: null,
    last_statuses: {},
    active: true,
  };

  if (env.PULSE_KV) {
    await env.PULSE_KV.put(`vendor:${email}`, JSON.stringify(subscriber), {
      metadata: { email, plan, product: 'vendor-watch', vendor_count: vendors.length },
    });
  }

  return json({ ok: true, message: `Watching ${vendors.length} vendor${vendors.length !== 1 ? 's' : ''}. Alerts go to ${email}.` });
}
