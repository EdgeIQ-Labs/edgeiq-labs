/**
 * POST /api/brandguard-signup
 * Body: { email, domain, stripe_session_id }
 *
 * BrandGuard is a paid-only product ($14/mo).
 * Requires a verified Stripe Checkout session_id.
 *
 * KV key   : brandguard:{email}:{domain}
 * KV value : { email, domain, active, created_at,
 *              last_scan_at, known_active: [], known_suspicious: [], scan_count }
 *
 * KV binding : PULSE_KV
 * Env vars   : STRIPE_SECRET_KEY
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
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function isDomain(d) { return /^[a-z0-9][a-z0-9\-\.]{1,61}[a-z0-9]\.[a-z]{2,}$/.test(d); }

async function verifyStripe(env, sessionId, email) {
  if (!env.STRIPE_SECRET_KEY || !sessionId) return false;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return false;
    const s = await r.json();
    if (s.payment_status !== 'paid' && s.status !== 'complete') return false;
    const sEmail = (s.customer_details?.email || s.customer_email || '').toLowerCase().trim();
    if (sEmail && sEmail !== email) return false;
    return true;
  } catch { return false; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email  = (body.email  || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const sid    = (body.stripe_session_id || '').trim();

  if (!isEmail(email))   return json({ error: 'Invalid email address.' }, 400);
  if (!isDomain(domain)) return json({ error: 'Invalid domain — use format: example.com' }, 400);
  if (!sid)              return json({ error: 'Stripe session required.' }, 402);

  const ok = await verifyStripe(env, sid, email);
  if (!ok) return json({ error: 'Could not verify payment. Contact support@edgeiqlabs.com.' }, 402);

  const record = {
    email, domain, plan: 'standard', active: true,
    created_at:         new Date().toISOString(),
    last_scan_at:       null,
    known_active:       [],
    known_suspicious:   [],
    scan_count:         0,
    stripe_session_id:  sid,
  };

  if (env.PULSE_KV) {
    await env.PULSE_KV.put(
      `brandguard:${email}:${domain}`,
      JSON.stringify(record),
      { metadata: { email, domain, created_at: record.created_at } }
    ).catch(e => console.error('KV write failed:', e.message));
  }

  return json({ ok: true, domain, message: `BrandGuard monitoring started for ${domain}.` });
}
