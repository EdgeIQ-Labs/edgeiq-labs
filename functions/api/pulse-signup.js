/**
 * EdgeIQ Pulse — Sign-up API
 * POST /api/pulse-signup
 * Body: { email, domain, plan }
 *
 * Stores subscriber in Cloudflare KV namespace `PULSE_KV`.
 * KV binding must be added in Cloudflare Pages dashboard:
 *   Variable name: PULSE_KV
 *   KV namespace: (create one named "edgeiq-pulse-subscribers")
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
    .replace(/^https?:\/\//, '').replace(/\/$/, '');
  const plan = (body.plan || 'free').trim().toLowerCase();

  if (!isValidEmail(email)) return json({ error: 'Invalid email address.' }, 400);
  if (!isValidDomain(domain)) return json({ error: 'Invalid domain. Use format: example.com' }, 400);
  if (!['free', 'pro', 'business'].includes(plan)) return json({ error: 'Invalid plan.' }, 400);

  const subscriber = {
    email,
    domain,
    plan,
    created_at: new Date().toISOString(),
    last_scan: null,
    last_findings: {},
    active: true,
  };

  const kvKey = `sub:${email}:${domain}`;

  if (env.PULSE_KV) {
    try {
      await env.PULSE_KV.put(kvKey, JSON.stringify(subscriber), {
        metadata: { email, domain, plan, created_at: subscriber.created_at },
      });
    } catch (err) {
      console.error('KV write failed:', err.message);
      // Continue — don't fail the user if KV is temporarily unavailable
    }
  }

  // Compute next scan date (next Monday at 08:00 UTC)
  const now = new Date();
  const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
  const nextScan = new Date(now);
  nextScan.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextScan.setUTCHours(8, 0, 0, 0);

  return json({
    ok: true,
    message: `Registered ${domain} for ${plan} monitoring.`,
    next_scan: nextScan.toISOString().split('T')[0],
    domain,
    plan,
  });
}
