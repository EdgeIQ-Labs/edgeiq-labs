/**
 * Digital Product Delivery Webhook
 * POST /api/webhooks/stripe-digital-download
 * 
 * Handles checkout.session.completed for one-time digital product purchases.
 * Generates a signed download token (HMAC-SHA256, 24h expiry) and stores
 * purchase record in PULSE_KV.
 * 
 * Stripe Checkout metadata required:
 *   product_type: 'digital'
 *   product_slug: e.g. 'hipaa-checklist', 'soc2-template'
 */
import { verifyWebhookSignature, parseStripeEvent } from '../../lib/stripe-webhook.js';
import { sendEmail } from '../../lib/email.js';

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

async function generateSignedToken(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hash = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hash;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature');

  const isValid = await verifyWebhookSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const event = parseStripeEvent(payload);
  if (!event) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  console.log(`[Digital Webhook] Event: ${event.type}, ID: ${event.id}`);

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data;
      const metadata = session.metadata || {};

      // Only handle digital product purchases
      if (metadata.product_type !== 'digital') {
        console.log('[Digital Webhook] Not a digital product, skipping');
        return new Response(JSON.stringify({ received: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const email = session.customer_email || session.customer_details?.email;
      const productSlug = metadata.product_slug;
      const productName = metadata.product_name || productSlug;
      const customerId = session.customer;
      const sessionId = session.id;

      if (!email || !productSlug) {
        console.log('[Digital Webhook] Missing email or product_slug');
        return new Response(JSON.stringify({ received: true }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Generate signed download token
      const tokenId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
      const tokenPayload = `${tokenId}:${productSlug}:${email}:${expiresAt}`;
      const tokenSig = await generateSignedToken(tokenPayload, env.STRIPE_SECRET_KEY);
      const downloadToken = `${tokenId}.${expiresAt}.${tokenSig}`;

      // Store purchase record
      const purchaseRecord = {
        email,
        productSlug,
        productName,
        customerId,
        sessionId,
        tokenId,
        downloadToken,
        purchasedAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        downloadsRemaining: 3,
      };

      await env.PULSE_KV.put(`digital:purchase:${sessionId}`, JSON.stringify(purchaseRecord));
      await env.PULSE_KV.put(`digital:token:${tokenId}`, JSON.stringify(purchaseRecord));
      await env.PULSE_KV.put(`digital:email:${email}:${productSlug}`, JSON.stringify({
        sessionId, tokenId, purchasedAt: purchaseRecord.purchasedAt
      }));

      console.log(`[Digital Webhook] ✅ Purchase recorded: ${email} → ${productSlug}, token: ${tokenId}`);

      // Send download email
      const downloadUrl = `https://edgeiqlabs.com/download/?token=${downloadToken}`;
      const html = `
        <div style="font-family:Inter,system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:40px 20px;">
          <div style="max-width:500px;margin:0 auto;background:#121923;border:1px solid #233142;border-radius:14px;padding:32px;">
            <h2 style="color:#3dd9ff;margin:0 0 12px;font-size:1.3rem;">📦 Your download is ready</h2>
            <p style="color:#9fb0c7;margin:0 0 20px;font-size:0.95rem;">Thanks for purchasing <strong>${productName}</strong>. Your secure download link is below.</p>
            <a href="${downloadUrl}" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:1rem;">Download Now →</a>
            <p style="color:#64748b;font-size:0.8rem;margin:20px 0 0;">Link expires in 24 hours · 3 downloads remaining<br>If the button doesn't work, copy this URL:<br><code style="color:#9fb0c7;word-break:break-all;">${downloadUrl}</code></p>
          </div>
        </div>`;

      await sendEmail(env.RESEND_API_KEY, {
        to: email,
        subject: `Your ${productName} download — EdgeIQ Labs`,
        html,
        from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
      });

      console.log(`[Digital Webhook] ✅ Download email sent to ${email}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error(`[Digital Webhook] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
