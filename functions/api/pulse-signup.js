/**
 * EdgeIQ Pulse — Sign-up API
 * POST /api/pulse-signup
 * Body: { email, domain, plan, stripe_session_id? }
 *
 * - Free plan: no Stripe required.
 * - Pro/Business plan: requires a valid completed Stripe Checkout session_id
 *   that matches the submitting email. Without it the request is rejected 402.
 *
 * KV binding: PULSE_KV
 * Env vars:   STRIPE_SECRET_KEY
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

/**
 * Verify a Stripe Checkout Session is paid and optionally matches the email.
 * Returns true if valid, false otherwise.
 */
async function verifyStripeSession(env, sessionId, email) {
  if (!env.STRIPE_SECRET_KEY) return false;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 10) return false;
  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!resp.ok) return false;
    const session = await resp.json();

    // Must be a completed / paid session
    if (session.payment_status !== 'paid' && session.status !== 'complete') return false;

    // Email must match (if Stripe captured one)
    const stripeEmail = (
      session.customer_details?.email ||
      session.customer_email ||
      ''
    ).toLowerCase().trim();

    if (stripeEmail && stripeEmail !== email) return false;

    return true;
  } catch {
    return false;
  }
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
  const rawPlan = (body.plan || 'free').trim().toLowerCase();
  const stripeSessionId = (body.stripe_session_id || '').trim();

  if (!isValidEmail(email)) return json({ error: 'Invalid email address.' }, 400);
  if (!isValidDomain(domain)) return json({ error: 'Invalid domain. Use format: example.com' }, 400);
  if (!['free', 'pro', 'business'].includes(rawPlan)) return json({ error: 'Invalid plan.' }, 400);

  // ── Paid-plan gate ───────────────────────────────────────────────────────────
  let plan = rawPlan;
  if (plan === 'pro' || plan === 'business') {
    if (!stripeSessionId) {
      return json({
        error: 'A completed Stripe checkout session is required for paid plans.',
        hint: 'Complete the checkout at edgeiqlabs.com/pulse/ first.',
      }, 402);
    }
    const valid = await verifyStripeSession(env, stripeSessionId, email);
    if (!valid) {
      return json({
        error: 'Could not verify Stripe payment. Please complete checkout or contact support@edgeiqlabs.com.',
      }, 402);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  const subscriber = {
    email,
    domain,
    plan,
    created_at: new Date().toISOString(),
    last_scan: null,
    last_findings: {},
    active: true,
    ...(stripeSessionId && { stripe_session_id: stripeSessionId }),
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
