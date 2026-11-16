/**
 * Compliance Report Checkout — $49 one-time
 * GET /api/compliance-report-checkout?email=you@company.com
 *
 * The email param is REQUIRED for auto-delivery: it prefills Stripe checkout
 * and lands in metadata + customer_email so the webhook can find the original
 * free report in KV. Without it the paid report cannot be matched.
 */

export async function onRequest(context) {
  const { request, env } = context;

  const PRICE_ID = env.COMPLIANCE_REPORT_PRICE_ID || 'price_1UbiQsRC1NZ20yDTWEfWxUZI';
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  try {
    const params = {
      mode: 'payment',
      success_url: 'https://edgeiqlabs.com/compliance-report/?purchased=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://edgeiqlabs.com/compliance-report/',
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[product]': 'compliance-report'
    };
    if (validEmail) {
      params.customer_email = email;
      params['metadata[email]'] = email;
    }

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
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
