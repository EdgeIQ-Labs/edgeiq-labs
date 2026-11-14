/**
 * Compliance Report Checkout — $49 one-time
 * GET /api/compliance-report-checkout
 */

export async function onRequest(context) {
  const { request, env } = context;

  // Price ID created below in same batch
  const PRICE_ID = env.COMPLIANCE_REPORT_PRICE_ID || 'price_1UbiQsRC1NZ20yDTWEfWxUZI';

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'payment',
        success_url: 'https://edgeiqlabs.com/compliance-report/?purchased=true&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://edgeiqlabs.com/compliance-report/',
        'line_items[0][price]': PRICE_ID,
        'line_items[0][quantity]': '1',
        'metadata[product]': 'compliance-report'
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
