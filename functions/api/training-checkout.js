/**
 * Training Checkout — Stripe Session Generator
 * POST /api/training-checkout
 * Body: { email, seats }
 * Returns: { url } — Stripe Checkout session URL
 *
 * Creates a subscription for $5/user/mo × seats.
 * Success redirect: /phishsim-training/?upgraded=true&session_id={CHECKOUT_SESSION_ID}
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const email = (body.email || '').toLowerCase().trim();
  const seats = Math.max(1, Math.min(500, parseInt(body.seats) || 1));

  if (!email || !email.includes('@')) {
    return json({ error: 'valid email required' }, 400);
  }

  const stripeKey = context.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'stripe not configured' }, 500);

  // Create or retrieve customer
  let customerId;
  const custSearch = await fetch('https://api.stripe.com/v1/customers/search?query=' + encodeURIComponent(`email:'${email}'`), {
    headers: { 'Authorization': `Bearer ${stripeKey}` },
  });
  const custData = await custSearch.json();
  if (custData.data && custData.data.length > 0) {
    customerId = custData.data[0].id;
  } else {
    const custCreate = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(email)}&metadata[product]=training`,
    });
    const newCust = await custCreate.json();
    customerId = newCust.id;
  }

  // Use existing price ID or create one
  // Training price: $5/user/mo = 500 cents
  const PRICE_ID = context.env.TRAINING_PRICE_ID;
  if (!PRICE_ID) return json({ error: 'TRAINING_PRICE_ID not set' }, 500);

  const origin = new URL(context.request.url).origin;
  const successUrl = `${origin}/phishsim-training/?upgraded=true&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/security-awareness-training/?cancelled=true`;

  const sessionResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'mode': 'subscription',
      'customer': customerId,
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': String(seats),
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'metadata[product]': 'training',
      'metadata[seats]': String(seats),
      'metadata[email]': email,
      'allow_promotion_codes': 'true',
    }).toString(),
  });

  const session = await sessionResp.json();
  if (session.error) return json({ error: session.error.message }, 400);

  return json({ url: session.url });
}
