/**
 * UptimePing Checkout — GET /api/uptimeping-checkout?plan=pro
 * Creates a Stripe Checkout Session and redirects.
 */
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }

  const url = new URL(request.url);
  const STRIPE_KEY = env.STRIPE_SECRET_KEY;
  const PRICE_ID = 'price_1UWIFYRC1NZ20yDTZjXiOlsk'; // UptimePing Pro $1/mo

  if (!STRIPE_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
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
        'line_items[0][price]': PRICE_ID,
        'line_items[0][quantity]': '1',
        'success_url': `${url.origin}/uptimeping/?checkout=success`,
        'cancel_url': `${url.origin}/uptimeping/`,
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
