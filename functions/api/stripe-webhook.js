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

        const customer = await provisionCustomer(kvNamespace, serviceConfig.slug, {
          email,
          customerId,
          subscriptionId,
          plan,
          apiKey,
        });

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
