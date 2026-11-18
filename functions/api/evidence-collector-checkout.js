/**
 * Compliance Evidence Collector — Stripe Checkout
 * POST /api/evidence-collector-checkout
 * Body: { email, org_name }
 * 
 * Creates a Stripe checkout session for $99/mo Evidence Collector subscription.
 * On success, redirects to /evidence-collector/?upgraded=true&session_id={CHECKOUT_SESSION_ID}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  const { env } = context;
  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email = body.email;
  const orgName = body.org_name || 'My Organization';

  if (!email) {
    return json({ error: 'Email required' }, 400);
  }

  const PRICE_ID = env.EVIDENCE_COLLECTOR_PRICE_ID || 'price_placeholder_evidence_collector';

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'subscription',
        customer_email: email,
        line_items: [{ price: PRICE_ID, quantity: 1 }],
        success_url: 'https://edgeiqlabs.com/evidence-collector/?upgraded=true&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://edgeiqlabs.com/evidence-collector/',
        metadata: JSON.stringify({ service: 'evidence-collector', org_name: orgName }),
        subscription_data: JSON.stringify({ metadata: { service: 'evidence-collector', org_name: orgName } }),
      }).toString(),
    });

    const session = await resp.json();
    if (session.error) {
      return json({ error: session.error.message }, 400);
    }

    return json({ url: session.url, session_id: session.id });

  } catch (e) {
    return json({ error: 'Checkout failed: ' + e.message }, 500);
  }
}
