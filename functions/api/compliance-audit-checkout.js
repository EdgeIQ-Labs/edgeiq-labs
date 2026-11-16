/**
 * Compliance Audit Checkout — $499 one-time
 * GET /api/compliance-audit-checkout?email=you@company.com&domain=example.com
 *
 * Creates a Stripe checkout session for the comprehensive compliance audit.
 * Email and domain are passed through so the webhook can deliver the audit.
 */

export async function onRequest(context) {
  const { request, env } = context;

  const PRICE_ID = env.COMPLIANCE_AUDIT_PRICE_ID || 'price_1UcPokRC1NZ20yDTGNTBlFOZ';
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  try {
    const params = {
      mode: 'payment',
      success_url: 'https://edgeiqlabs.com/compliance-audit/?purchased=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://edgeiqlabs.com/compliance-audit/',
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': '1',
      'metadata[product]': 'compliance-audit'
    };
    if (validEmail) {
      params.customer_email = email;
      params['metadata[email]'] = email;
    }
    if (domain) {
      params['metadata[domain]'] = domain;
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
