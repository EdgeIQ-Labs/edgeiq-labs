/**
 * EdgeIQ Inbox Shield — Sign-up API
 * POST /api/inbox-shield-signup
 * Body: { email, domain, plan }
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

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function isValidDomain(d) {
  return /^[a-zA-Z0-9][a-zA-Z0-9\-\.]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(d);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const plan = (body.plan || 'free').trim().toLowerCase();

  if (!isValidEmail(email)) return json({ error: 'Invalid email address.' }, 400);
  if (!isValidDomain(domain)) return json({ error: 'Invalid domain. Use format: example.com' }, 400);
  if (!['free', 'pro'].includes(plan)) return json({ error: 'Invalid plan.' }, 400);

  const subscriber = {
    email,
    domain,
    plan,
    product: 'inbox-shield',
    created_at: new Date().toISOString(),
    last_scan: null,
    last_findings: null,
    active: true,
  };

  const kvKey = `shield:${email}:${domain}`;

  if (env.PULSE_KV) {
    try {
      await env.PULSE_KV.put(kvKey, JSON.stringify(subscriber), {
        metadata: { email, domain, plan, product: 'inbox-shield', created_at: subscriber.created_at },
      });
    } catch (err) {
      console.error('KV write failed:', err.message);
    }
  }

  // Next Monday 08:00 UTC
  const now = new Date();
  const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
  const nextScan = new Date(now);
  nextScan.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextScan.setUTCHours(8, 0, 0, 0);

  return json({
    ok: true,
    message: `Registered ${domain} for Inbox Shield monitoring.`,
    next_scan: nextScan.toISOString().split('T')[0],
    domain,
    plan,
  });
}
