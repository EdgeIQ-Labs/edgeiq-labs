/**
 * EdgeIQ StatusPage — Stripe Checkout Session Creator
 * Route: /api/statuspage-checkout?plan=starter|pro|business
 */

const PLANS = {
  starter: { priceId: 'price_statuspage_starter', name: 'StatusPage Starter', amount: 900 },
  pro: { priceId: 'price_statuspage_pro', name: 'StatusPage Pro', amount: 1900 },
  business: { priceId: 'price_statuspage_business', name: 'StatusPage Business', amount: 4900 },
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
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    
    // Check if we have a real price ID or need to use inline pricing
    let lineItems;
    if (planConfig.priceId.startsWith('price_')) {
      lineItems = [{ price: planConfig.priceId, quantity: 1 }];
    } else {
      // Inline pricing for initial launch before Stripe products are created
      lineItems = [{
        price_data: {
          currency: 'usd',
          product_data: { name: planConfig.name },
          unit_amount: planConfig.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${url.origin}/statuspage/dashboard/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/statuspage/`,
      metadata: { product: 'statuspage', plan },
      subscription_data: {
        metadata: { product: 'statuspage', plan },
      },
    });

    return Response.redirect(session.url, 303);
  } catch (e) {
    console.error('StatusPage checkout error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
