/**
 * POST /api/vendor-watch-signup
 * Body: { email, vendors: ['stripe','github',...], plan, stripe_session_id? }
 *
 * - Free plan (≤5 vendors): no Stripe required.
 * - Pro plan (up to 14 vendors): requires a valid completed Stripe Checkout
 *   session_id that matches the submitting email. Without it → 402.
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

/**
 * Verify a Stripe Checkout Session is paid and optionally matches the email.
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

    if (session.payment_status !== 'paid' && session.status !== 'complete') return false;

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
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const rawPlan = (body.plan || 'free').trim().toLowerCase();
  const stripeSessionId = (body.stripe_session_id || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);
  if (!['free', 'pro'].includes(rawPlan)) return json({ error: 'Invalid plan' }, 400);

  // ── Paid-plan gate ───────────────────────────────────────────────────────────
  let plan = rawPlan;
  if (plan === 'pro') {
    if (!stripeSessionId) {
      return json({
        error: 'A completed Stripe checkout session is required for the Pro plan.',
        hint: 'Complete the checkout at edgeiqlabs.com/vendor-watch/ first.',
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

  // Enforce vendor limits per plan
  if (plan === 'free' && Array.isArray(body.vendors) && body.vendors.length > 5) {
    return json({ error: 'Free plan supports up to 5 vendors. Upgrade to Pro for all 14.' }, 403);
  }

  const limit = plan === 'pro' ? 20 : 5;
  const vendors = Array.isArray(body.vendors) ? body.vendors.slice(0, limit) : [];

  const subscriber = {
    email, vendors, plan,
    product: 'vendor-watch',
    created_at: new Date().toISOString(),
    last_check: null,
    last_statuses: {},
    active: true,
    ...(stripeSessionId && { stripe_session_id: stripeSessionId }),
  };

  if (env.PULSE_KV) {
    try {
      await env.PULSE_KV.put(`vendor:${email}`, JSON.stringify(subscriber), {
        metadata: { email, plan, product: 'vendor-watch', vendor_count: vendors.length },
      });
    } catch (err) {
      console.error('KV write failed:', err.message);
    }
  }

  return json({
    ok: true,
    message: `Watching ${vendors.length} vendor${vendors.length !== 1 ? 's' : ''}. Alerts go to ${email}.`,
  });
}
