/**
 * Digital Product Checkout
 * GET /api/digital-checkout?product=<slug>
 * 
 * Creates a Stripe Checkout session for a one-time digital product purchase.
 * Passes product metadata to webhook for fulfillment.
 */

const DIGITAL_PRODUCTS = {
  'hipaa-checklist': {
    name: 'HIPAA Compliance Checklist 2026',
    priceId: 'price_1Qx2KjRC1NZ20yDTaBcDeFgH', // Replace with real Stripe price ID
    amount: 2900, // $29.00 in cents
  },
  'soc2-template': {
    name: 'SOC2 Readiness Template Pack',
    priceId: 'price_1Qx2KlRC1NZ20yDTbCdEfGhI',
    amount: 4900,
  },
  'security-policy-bundle': {
    name: 'Security Policy Bundle',
    priceId: 'price_1Qx2KmRC1NZ20yDTcDeFgHiJ',
    amount: 9900,
  },
  'geo-audit-guide': {
    name: 'GEO Optimization Guide',
    priceId: 'price_1Qx2KnRC1NZ20yDTdEfGhIjK',
    amount: 1900,
  },
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const productSlug = url.searchParams.get('product');

  if (!productSlug || !DIGITAL_PRODUCTS[productSlug]) {
    return new Response(JSON.stringify({
      error: 'Invalid product',
      available: Object.keys(DIGITAL_PRODUCTS)
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const product = DIGITAL_PRODUCTS[productSlug];

  try {
    const formData = new URLSearchParams();
    formData.append('mode', 'payment');
    formData.append('success_url', `${url.origin}/store/success/?session_id={CHECKOUT_SESSION_ID}&product=${productSlug}`);
    formData.append('cancel_url', `${url.origin}/store/`);
    formData.append('line_items[0][price]', product.priceId);
    formData.append('line_items[0][quantity]', '1');
    formData.append('metadata[product_type]', 'digital');
    formData.append('metadata[product_slug]', productSlug);
    formData.append('metadata[product_name]', product.name);
    formData.append('customer_creation', 'always');
    formData.append('billing_address_collection', 'auto');

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) {
      return new Response('Stripe parse error', { status: 500 });
    }

    if (data.url) {
      return new Response(null, { status: 303, headers: { Location: data.url } });
    }
    return new Response(JSON.stringify(data), {
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
