/**
 * EdgeIQ StatusPage — Stripe Checkout Session Creator
 * Route: /api/statuspage-checkout?plan=starter|pro|business
 */

const PLANS = {
  starter: { priceId: 'price_1UbfMqRC1NZ20yDTM38VIK93', name: 'StatusPage Starter' },
  pro: { priceId: 'price_1UbfMrRC1NZ20yDTSwf5TYUo', name: 'StatusPage Pro' },
  business: { priceId: 'price_1UbfMrRC1NZ20yDTl88DAvKy', name: 'StatusPage Business' },
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'starter';
  const planConfig = PLANS[plan];

  if (!planConfig) {
    return new Response(JSON.stringify({ error: 'Invalid plan' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create checkout session via raw Stripe API (no SDK dependency)
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('success_url', `${url.origin}/statuspage/dashboard/?session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${url.origin}/statuspage/`);
    params.set('metadata[product]', 'statuspage');
    params.set('metadata[plan]', plan);
    params.set('subscription_data[metadata][product]', 'statuspage');
    params.set('subscription_data[metadata][plan]', plan);
    params.set('line_items[0][price]', planConfig.priceId);
    params.set('line_items[0][quantity]', '1');

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await res.json();
    if (!res.ok || !session.url) {
      console.error('Stripe checkout error:', session);
      return new Response(JSON.stringify({ error: session.error?.message || 'Checkout failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return Response.redirect(session.url, 303);
  } catch (e) {
    console.error('StatusPage checkout error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
