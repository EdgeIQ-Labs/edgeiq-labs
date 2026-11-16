/**
 * EdgeIQ Verified Badge Checkout — $99/year subscription
 * GET /api/badge-checkout?domain=example.com&email=you@company.com
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const PRICE_ID = env.BADGE_PRICE_ID || 'price_1UcOIGRC1NZ20yDTpuXPodLz';
  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  const email = (url.searchParams.get('email') || '').trim();

  if (!domain || !email) {
    return new Response(JSON.stringify({ error: 'Missing domain or email' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
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
        success_url: `https://edgeiqlabs.com/badge/dashboard/?session_id={CHECKOUT_SESSION_ID}&domain=${encodeURIComponent(domain)}`,
        cancel_url: 'https://edgeiqlabs.com/badge/',
        'line_items[0][price]': PRICE_ID,
        'line_items[0][quantity]': '1',
        customer_email: email,
        'metadata[service]': 'verified-badge',
        'metadata[domain]': domain,
      }).toString()
    });

    const session = await resp.json();
    if (session.url) {
      return Response.redirect(session.url, 303);
    }
    return new Response(JSON.stringify({ error: session.error?.message || 'Checkout failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
