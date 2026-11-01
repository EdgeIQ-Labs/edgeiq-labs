/**
 * EdgeIQ — LicenseAudit Pro Checkout
 * POST /api/license-audit-checkout
 *
 * Creates a fresh Stripe Checkout Session for the $29 one-time SBOM export.
 * Returns { url } to redirect the user to Stripe.
 *
 * Env: STRIPE_SECRET_KEY (set in CF Pages → Settings → Environment variables)
 */

const PRICE_ID = 'price_1UWzQXRC1NZ20yDTtuWhhg8k';
const SUCCESS_URL = 'https://edgeiqlabs.com/free-license-audit/?upgraded=true';
const CANCEL_URL = 'https://edgeiqlabs.com/free-license-audit/';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const stripeKey = context.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'payment',
        'line_items[0][price]': PRICE_ID,
        'line_items[0][quantity]': '1',
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
        'metadata[tool]': 'license-audit',
      }).toString(),
    });

    const data = await res.json();

    if (data.error) {
      return new Response(JSON.stringify({ error: data.error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify({ url: data.url }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Checkout failed: ${e.message}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
