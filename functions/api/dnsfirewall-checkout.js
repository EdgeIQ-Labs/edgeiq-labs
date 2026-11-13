/**
 * EdgeIQ DNS Firewall — Stripe Checkout Session Creator
 * Uses raw fetch (no SDK) for CF Pages compatibility
 */

const PRICES = {
  personal: { amount: 500, name: 'DNS Firewall Personal', interval: 'month' },
  business: { amount: 1900, name: 'DNS Firewall Business', interval: 'month' },
};

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'personal';
  const priceConfig = PRICES[plan];
  
  if (!priceConfig) {
    return new Response(JSON.stringify({ error: 'Invalid plan' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  try {
    const body = new URLSearchParams();
    body.append('mode', 'subscription');
    body.append('success_url', 'https://edgeiqlabs.com/dnsfirewall/dashboard/?session_id={CHECKOUT_SESSION_ID}');
    body.append('cancel_url', 'https://edgeiqlabs.com/dnsfirewall/');
    body.append('metadata[product]', 'dnsfirewall');
    body.append('metadata[plan]', plan);
    body.append('line_items[0][price_data][currency]', 'usd');
    body.append('line_items[0][price_data][unit_amount]', priceConfig.amount);
    body.append('line_items[0][price_data][recurring][interval]', priceConfig.interval);
    body.append('line_items[0][price_data][product_data][name]', priceConfig.name);
    body.append('line_items[0][quantity]', '1');
    
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    
    const text = await res.text();
    let session;
    try { session = JSON.parse(text); } catch { session = text; }

    if (!res.ok) {
      console.error('Stripe checkout error:', JSON.stringify(session));
      return new Response(JSON.stringify({ error: 'Checkout failed', detail: typeof session === 'object' ? session : text }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    return new Response(null, {
      status: 303,
      headers: { 'Location': session.url },
    });
  } catch (e) {
    console.error('Checkout error:', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
