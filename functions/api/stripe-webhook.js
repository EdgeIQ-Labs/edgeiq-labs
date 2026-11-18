/**
 * Universal Stripe Webhook Handler
 * POST /api/stripe-webhook
 * Handles checkout.session.completed + customer.subscription.updated/deleted
 * Provisions customers, sends welcome emails, manages subscription lifecycle
 */
import { verifyWebhookSignature, parseStripeEvent } from '../lib/stripe-webhook.js';
import { sendEmail, welcomeEmailTemplate } from '../lib/email.js';
import { generateApiKey, detectService, provisionCustomer, SERVICE_CONFIG } from '../lib/provision.js';

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature');
  
  // Verify signature
  const isValid = await verifyWebhookSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const event = parseStripeEvent(payload);
  if (!event) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  console.log(`[Stripe Webhook] Event: ${event.type}, ID: ${event.id}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data;
        const email = session.customer_email || session.customer_details?.email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        
        if (!email || !customerId) {
          console.log('[Webhook] Missing email or customer ID, skipping');
          break;
        }

        // Detect which service this is for based on line items
        let serviceConfig = null;
        let plan = 'starter';
        
        if (session.line_items?.data) {
          for (const item of session.line_items.data) {
            const detected = detectService(item.price.id);
            if (detected) {
              serviceConfig = detected;
              plan = detected.plan;
              break;
            }
          }
        }
        
        // Fallback: check metadata
        if (!serviceConfig && session.metadata?.service) {
          const slug = session.metadata.service;
          if (SERVICE_CONFIG[slug]) {
            serviceConfig = { slug, ...SERVICE_CONFIG[slug], plan };
          }
        }
        
        // ── Digital product delivery (one-time purchases) ──────────────────
        if (!serviceConfig && session.metadata?.product_type === 'digital') {
          const productSlug = session.metadata.product_slug;
          const productName = session.metadata.product_name || productSlug;
          const sessionId = session.id;

          if (!email || !productSlug) {
            console.log('[Webhook] Digital purchase missing email or product_slug');
            break;
          }

          // Generate signed download token (HMAC-SHA256, 24h expiry)
          const tokenId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
          const tokenPayload = `${tokenId}:${productSlug}:${email}:${expiresAt}`;
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw', encoder.encode(env.STRIPE_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
          );
          const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(tokenPayload));
          const tokenSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
          const downloadToken = `${tokenId}.${expiresAt}.${tokenSig}`;

          const purchaseRecord = {
            email, productSlug, productName, customerId, sessionId,
            tokenId, downloadToken,
            purchasedAt: new Date().toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
            downloadsRemaining: 3,
          };

          await env.PULSE_KV.put(`digital:purchase:${sessionId}`, JSON.stringify(purchaseRecord));
          await env.PULSE_KV.put(`digital:token:${tokenId}`, JSON.stringify(purchaseRecord));
          await env.PULSE_KV.put(`digital:email:${email}:${productSlug}`, JSON.stringify({
            sessionId, tokenId, purchasedAt: purchaseRecord.purchasedAt
          }));

          console.log(`[Webhook] ✅ Digital purchase: ${email} → ${productSlug}, token: ${tokenId}`);

          // Send download email
          const downloadUrl = `https://edgeiqlabs.com/download/?token=${downloadToken}`;
          const dlHtml = `<div style="font-family:Inter,system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:40px 20px;"><div style="max-width:500px;margin:0 auto;background:#121923;border:1px solid #233142;border-radius:14px;padding:32px;"><h2 style="color:#3dd9ff;margin:0 0 12px;font-size:1.3rem;">📦 Your download is ready</h2><p style="color:#9fb0c7;margin:0 0 20px;font-size:0.95rem;">Thanks for purchasing <strong>${productName}</strong>.</p><a href="${downloadUrl}" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 28px;border-radius:9px;text-decoration:none;font-size:1rem;">Download Now →</a><p style="color:#64748b;font-size:0.8rem;margin:20px 0 0;">Link expires in 24 hours · 3 downloads remaining</p></div></div>`;

          await sendEmail(env.RESEND_API_KEY, {
            to: email,
            subject: `Your ${productName} download — EdgeIQ Labs`,
            html: dlHtml,
            from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
          });

          console.log(`[Webhook] ✅ Download email sent to ${email}`);
          break;
        }

        if (!serviceConfig) {
          console.log(`[Webhook] Could not detect service for session ${event.id}`);
          break;
        }

        console.log(`[Webhook] Provisioning ${email} for ${serviceConfig.name} (${plan})`);

        // Generate API key and provision
        const apiKey = generateApiKey(serviceConfig.slug.substring(0, 2));
        const kvNamespace = env[`${serviceConfig.kvPrefix}KV`] || env.KV;
        
        if (!kvNamespace) {
          console.log(`[Webhook] No KV namespace bound for ${serviceConfig.name}`);
          break;
        }

        // Special handling for verified-badge: custom KV structure
        if (serviceConfig.slug === 'verified-badge') {
          const domain = session.metadata?.domain || '';
          const badgeId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          const now = new Date();
          const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
          const badgeData = {
            id: badgeId,
            domain,
            email,
            customerId,
            subscriptionId,
            company: '',
            logo: null,
            verified_at: now.toISOString(),
            expires_at: expires.toISOString(),
            status: 'active',
          };
          await kvNamespace.put(`vbadge:${badgeId}`, JSON.stringify(badgeData));
          await kvNamespace.put(`vbadge:domain:${domain}`, badgeId);
          await kvNamespace.put(`vbadge:email:${email}`, badgeId);
          await kvNamespace.put(`vbadge:stripe:${customerId}`, badgeId);
          await kvNamespace.put(`vbadge:key:${badgeId}`, apiKey);
          console.log(`[Webhook] ✅ Badge ${badgeId} created for ${domain}`);
        } else {
          await provisionCustomer(kvNamespace, serviceConfig.slug, {
            email,
            customerId,
            subscriptionId,
            plan,
            apiKey,
          });
        }

        // Send welcome email
        const dashboardUrl = `https://edgeiqlabs.com${serviceConfig.dashboardPath}`;
        const html = welcomeEmailTemplate({
          serviceName: serviceConfig.name,
          customerName: email.split('@')[0],
          dashboardUrl,
          apiKey,
        });

        await sendEmail(env.RESEND_API_KEY, {
          to: email,
          subject: `Welcome to ${serviceConfig.name} — Your Account is Ready`,
          html,
          from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
        });

        console.log(`[Webhook] ✅ Provisioned ${email} for ${serviceConfig.name}, welcome email sent`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data;
        const customerId = sub.customer;
        const status = sub.status;
        
        // Find which service this belongs to and update KV
        console.log(`[Webhook] Subscription ${sub.id} updated to ${status}`);
        // TODO: Update customer record in KV with new status/plan
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data;
        const customerId = sub.customer;
        
        console.log(`[Webhook] Subscription ${sub.id} cancelled for ${customerId}`);
        // TODO: Mark customer as cancelled in KV, revoke API key
        break;
      }

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`[Webhook] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
