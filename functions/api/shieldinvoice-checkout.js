/**
 * ShieldInvoice Checkout — GET /api/shieldinvoice-checkout?plan=starter|pro
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'starter';

  const PRICE_IDS = {
    starter: 'price_1UY8fpRC1NZ20yDTl4UJg8YG',
    pro: 'price_1UY8fpRC1NZ20yDTl4UJg8YG',
  };

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return new Response(JSON.stringify({ error: 'Invalid plan' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const session = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'mode': 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'success_url': `${url.origin}/shieldinvoice/?checkout=success`,
        'cancel_url': `${url.origin}/shieldinvoice/`,
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
