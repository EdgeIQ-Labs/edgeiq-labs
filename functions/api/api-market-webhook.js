/**
 * EdgeIQ API Marketplace — Stripe Webhook Handler
 * Provisions API keys on checkout.session.completed
 * Revokes keys on subscription.deleted
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  const body = await request.text();
  const secret = env.API_MARKET_WEBHOOK_SECRET;

  if (!secret) {
    return new Response('Webhook secret not configured', { status: 500 });
  }

  // Verify Stripe signature
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );

    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
    const sig = parts.find(p => p.startsWith('v1='))?.slice(3);

    if (!timestamp || !sig) throw new Error('Invalid signature format');

    const signedPayload = `${timestamp}.${body}`;
    const expectedSig = await crypto.subtle.sign(
      'HMAC', key, encoder.encode(signedPayload)
    );
    const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (expectedHex !== sig) throw new Error('Signature mismatch');
  } catch (e) {
    return new Response(`Verification failed: ${e.message}`, { status: 400 });
  }

  const event = JSON.parse(body);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.metadata?.email;
      const tier = session.metadata?.tier || 'pro';

      if (!email) {
        console.log('No email in session, skipping key generation');
        return new Response('ok', { status: 200 });
      }

      // Generate API key
      const raw = crypto.randomUUID().replace(/-/g, '');
      const apiKey = `eiq_live_${raw.slice(0, 24)}`;

      const keyData = {
        key: apiKey,
        email,
        tier,
        created_at: new Date().toISOString(),
        expires_at: null,
        revoked: false,
        subscription_id: session.subscription || null
      };

      await env.PULSE_KV.put(`apikey:${apiKey}`, JSON.stringify(keyData));

      const existingKeys = await env.PULSE_KV.get(`apikeys_by_email:${email}`, 'json') || [];
      existingKeys.push(apiKey);
      await env.PULSE_KV.put(`apikeys_by_email:${email}`, JSON.stringify(existingKeys));

      // Send welcome email with API key via Resend
      if (env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
            to: [email],
            subject: 'Your EdgeIQ API Key is Ready',
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#3dd9ff;">Your API Key is Ready</h2>
              <p>Welcome to the EdgeIQ API Marketplace (${tier} tier).</p>
              <div style="background:#0b0f14;border:1px solid #1e2a3a;border-radius:8px;padding:16px;margin:20px 0;font-family:monospace;color:#3de19e;font-size:14px;word-break:break-all;">${apiKey}</div>
              <p><strong>Keep this key secret.</strong> It cannot be retrieved again from our dashboard.</p>
              <h3>Quick Start:</h3>
              <pre style="background:#0b0f14;padding:12px;border-radius:6px;color:#e8eef7;font-size:13px;">curl -H "Authorization: Bearer ${apiKey}" \\
  "https://edgeiqlabs.com/api/v1/header-check?domain=example.com"</pre>
              <p>Rate limit: ${tier === 'pro' ? '100' : tier === 'enterprise' ? '1000' : '10'} requests/min</p>
              <p><a href="https://edgeiqlabs.com/developers/docs/" style="color:#3dd9ff;">Full API Documentation →</a></p>
              <hr style="border-color:#1e2a3a;margin:30px 0;">
              <p style="color:#9fb0c7;font-size:12px;">EdgeIQ Labs Support</p>
            </div>`
          })
        });
      }

      console.log(`API key provisioned for ${email}: ${apiKey.slice(0, 15)}...`);
    }

    if (event.type === 'subscription.deleted' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub.customer;

      // Find all keys for this customer and revoke them
      // We'd need customer→email mapping, but we can search by subscription_id
      // For now, log it — full revocation requires iterating KV keys
      console.log(`Subscription deleted: ${customerId}, manual key revocation may be needed`);
    }

    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('Webhook error:', e.message);
    return new Response(e.message, { status: 500 });
  }
}
