/**
 * GET /api/report/fetch?order=UUID&session_id=XXX
 * Verifies Stripe payment, returns report data.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!env.PULSE_KV) return json({ error: 'Storage not configured' }, 500);

  const url = new URL(request.url);
  const orderId = url.searchParams.get('order');
  const sessionId = url.searchParams.get('session_id');

  if (!orderId) return json({ error: 'Missing order ID' }, 400);

  const raw = await env.PULSE_KV.get(`report:${orderId}`);
  if (!raw) return json({ error: 'Order not found or expired' }, 404);

  const order = JSON.parse(raw);

  // Already confirmed paid — return immediately
  if (order.status === 'paid') return json({ ok: true, order });

  // Verify payment via Stripe session
  if (!sessionId) return json({ error: 'Payment not confirmed' }, 403);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe not configured' }, 500);

  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  if (!stripeResp.ok) return json({ error: 'Could not verify payment' }, 502);

  const session = await stripeResp.json();

  if (session.payment_status !== 'paid') {
    return json({ error: 'Payment not completed' }, 403);
  }

  // Mark as paid in KV
  const updated = { ...order, status: 'paid', paid_at: new Date().toISOString() };
  await env.PULSE_KV.put(`report:${orderId}`, JSON.stringify(updated), {
    expirationTtl: 60 * 60 * 24 * 30, // extend to 30 days after payment
  });

  return json({ ok: true, order: updated });
}
