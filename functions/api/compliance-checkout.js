/**
 * Compliance Checkout — GET /api/compliance-checkout?plan=starter|pro
 * Creates a Stripe Checkout Session and redirects.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'starter';
  const STRIPE_KEY = env.STRIPE_SECRET_KEY || 'sk_liv...1X9D';

  const PRICE_IDS = {'starter': 'price_1UWegSRC1NZ20yDT6bCl1jAp', 'pro': 'price_1UWegSRC1NZ20yDTZdPzn7Tn'};
  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return new Response(JSON.stringify({ error: 'Invalid plan' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': `${url.origin}/compliance/?checkout=success`,
        'cancel_url': `${url.origin}/compliance/`,
        'allow_promotion_codes': 'true',
      })
    });

    if (!session.ok) {
      const err = await session.text();
      return new Response(JSON.stringify({ error: 'Stripe error', detail: err }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const data = await session.json();
    return Response.redirect(data.url, 302);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
