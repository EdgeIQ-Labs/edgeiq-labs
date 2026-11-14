/**
 * CompliancePro Checkout — $499/mo subscription
 * GET /api/compliancepro-checkout
 */
export async function onRequest(context) {
  const { request, env } = context;
  const PRICE_ID = env.COMPLIANCEPRO_PRICE_ID || 'price_1Ubj1YRC1NZ20yDTimldcLFf';
  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mode: 'subscription',
        success_url: 'https://edgeiqlabs.com/whitelabel-reports/?upgraded=compliancepro&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://edgeiqlabs.com/whitelabel-reports/',
        'line_items[0][price]': PRICE_ID,
        'line_items[0][quantity]': '1',
        'metadata[product]': 'compliancepro',
        'metadata[tier]': 'compliancepro'
      }).toString()
    });
    const session = await resp.json();
    if (session.url) return Response.redirect(session.url, 303);
    return new Response(JSON.stringify({ error: session.error?.message || 'Checkout failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
