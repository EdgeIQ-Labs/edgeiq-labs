/**
 * Verify Stripe webhook signature
 */
export async function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.substring(2);
  const sig = parts.find(p => p.startsWith('v1='))?.substring(3);
  
  if (!timestamp || !sig) return false;
  
  // Check timestamp freshness (5 min tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  
  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return expected === sig;
}

/**
 * Extract event type and data from Stripe webhook payload
 */
export function parseStripeEvent(payload) {
  try {
    const event = JSON.parse(payload);
    return {
      type: event.type,
      id: event.id,
      data: event.data?.object,
      customer: event.data?.object?.customer,
      subscription: event.data?.object?.subscription,
      email: event.data?.object?.customer_email || event.data?.object?.receipt_email,
    };
  } catch {
    return null;
  }
}
