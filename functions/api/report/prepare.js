/**
 * POST /api/report/prepare
 * Stores scan data in KV, creates a Stripe Checkout Session.
 * Returns { checkoutUrl }
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

function randomId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe not configured' }, 500);
  if (!env.PULSE_KV) return json({ error: 'Storage not configured' }, 500);

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { email, scanType, scanResults, clientName, consultantName, targetUrl, priceId } = body;
  if (!email || !scanResults?.length) return json({ error: 'email and scanResults are required' }, 400);

  const orderId = randomId();
  const siteUrl = 'https://edgeiqlabs.com';

  // Store order in KV (7-day TTL)
  const order = {
    orderId,
    email,
    scanType: scanType || 'Security Scan',
    scanResults,
    clientName: clientName || '',
    consultantName: consultantName || 'EdgeIQ Labs',
    targetUrl: targetUrl || '',
    status: 'pending',
    created_at: new Date().toISOString(),
  };

  await env.PULSE_KV.put(`report:${orderId}`, JSON.stringify(order), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });

  // Create Stripe Checkout Session
  const price = priceId || 'price_1TT3umRC1NZ20yDTIRCqCBPW';
  const successUrl = `${siteUrl}/report/view/?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${siteUrl}/report.html`;

  const params = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[order_id]': orderId,
    'payment_intent_data[metadata][order_id]': orderId,
  });

  const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    },
    body: params.toString(),
  });

  if (!stripeResp.ok) {
    const err = await stripeResp.text();
    console.error('Stripe error:', err);
    return json({ error: 'Failed to create checkout session' }, 502);
  }

  const session = await stripeResp.json();
  return json({ orderId, checkoutUrl: session.url });
}
