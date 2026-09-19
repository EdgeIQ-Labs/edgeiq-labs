/**
 * POST /api/vps-checkout
 * Body: { plan: 'nano'|'micro'|'basic'|'standard', os: 'ubuntu'|'debian'|'rocky'|'alma' }
 *
 * Creates a Stripe Checkout Session with VPS metadata so the webhook
 * knows exactly what to provision on Proxmox.
 *
 * Env vars: STRIPE_SECRET_KEY, SITE_URL
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

// Map plan names to Stripe Price IDs
const PLAN_PRICES = {
  nano:     'price_1Tb2VFRC1NZ20yDTfhCJ6651',
  micro:    'price_1Tb2VHRC1NZ20yDTPFoMZmhj',
  basic:    'price_1Tb2VJRC1NZ20yDTIFFVAmJb',
  standard: 'price_1Tb2VKRC1NZ20yDTawsJRCJ6',
};

const VALID_OS = ['ubuntu', 'debian', 'rocky', 'alma'];

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Service not configured' }, 503);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const plan = (body.plan || '').toLowerCase().trim();
  const os = (body.os || '').toLowerCase().trim();

  if (!PLAN_PRICES[plan]) {
    return json({ error: 'Invalid plan. Choose: nano, micro, basic, standard' }, 400);
  }
  if (!VALID_OS.includes(os)) {
    return json({ error: 'Invalid OS. Choose: ubuntu, debian, rocky, alma' }, 400);
  }

  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const priceId = PLAN_PRICES[plan];

  // Create Stripe Checkout Session with metadata
  const params = new URLSearchParams({
    mode: 'subscription',
    success_url: `${siteUrl}/vps/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/vps/`,
    'metadata[plan]': plan,
    'metadata[os]': os,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
  });

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('Stripe checkout error:', errText.slice(0, 200));
      return json({ error: 'Could not create checkout session' }, 502);
    }

    const session = await resp.json();
    return json({ ok: true, url: session.url });
  } catch (err) {
    console.error('Checkout creation failed:', err.message);
    return json({ error: 'Checkout service unavailable' }, 502);
  }
}
