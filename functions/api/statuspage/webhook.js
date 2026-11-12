/**
 * EdgeIQ StatusPage — Stripe Webhook Handler
 * Route: /api/statuspage/webhook
 * Handles: checkout.session.completed, customer.subscription.updated/deleted
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    // For initial testing without webhook secret, parse directly
    // In production, verify signature:
    // event = stripe.webhooks.constructEvent(body, sig, env.STATUSPAGE_WEBHOOK_SECRET);
    event = JSON.parse(body);
  } catch (e) {
    console.error('Webhook parse error:', e);
    return new Response('Invalid payload', { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        const plan = session.metadata?.plan || 'starter';
        const customerId = session.customer;
        
        if (email && customerId) {
          // Create default status page for new subscriber
          const slug = email.split('@')[0].replace(/[^a-z0-9]/g, '-').slice(0, 30) + '-' + Date.now().toString(36);
          const pageId = crypto.randomUUID();
          
          await env.STATUSPAGE_DB.prepare(
            'INSERT OR IGNORE INTO pages (id, slug, name, owner_email, stripe_customer_id, tier) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(pageId, slug, 'My Status Page', email, customerId, plan).run();
          
          console.log(`StatusPage: Created page ${slug} for ${email} (${plan})`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const plan = sub.items.data[0]?.plan?.nickname?.toLowerCase() || 
                     (sub.items.data[0]?.amount === 900 ? 'starter' : 
                      sub.items.data[0]?.amount === 1900 ? 'pro' : 'business');
        
        await env.STATUSPAGE_DB.prepare(
          'UPDATE pages SET tier = ?, updated_at = datetime("now") WHERE stripe_customer_id = ?'
        ).bind(plan, customerId).run();
        
        console.log(`StatusPage: Updated tier to ${plan} for ${customerId}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        
        // Downgrade to free/starter but don't delete — preserve incident history
        await env.STATUSPAGE_DB.prepare(
          'UPDATE pages SET tier = "starter", updated_at = datetime("now") WHERE stripe_customer_id = ?'
        ).bind(customerId).run();
        
        console.log(`StatusPage: Downgraded ${customerId} on cancellation`);
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Webhook handler error:', e);
    return new Response('Handler error', { status: 500 });
  }
}
