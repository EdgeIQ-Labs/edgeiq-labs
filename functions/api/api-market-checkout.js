/**
 * EdgeIQ API Marketplace — Stripe Checkout
 * GET /api/api-market-checkout?plan=pro|enterprise
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'pro';

  const PRICE_IDS = {
    pro: 'price_1UbiBeRC1NZ20yDTC0t9sPsm',
    enterprise: 'price_1UbiBeRC1NZ20yDT6zCg9vNl'
  };

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return new Response('Invalid plan', { status: 400 });
  }

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'subscription',
        success_url: `https://edgeiqlabs.com/developers/?upgraded=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: 'https://edgeiqlabs.com/developers/',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'metadata[tier]': plan,
        'metadata[product]': 'api-marketplace'
      }).toString()
    });

    const session = await resp.json();
    if (session.url) {
      return Response.redirect(session.url, 303);
    }
    return new Response(JSON.stringify({ error: session.error?.message || 'Checkout failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
