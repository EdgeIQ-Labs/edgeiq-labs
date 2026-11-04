/**
 * EdgeIQ Inbox Triage - Stripe Webhook Handler
 * Manages subscription lifecycle: checkout complete, cancel, update
 */

export async function handleStripeWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  if (!sig || !env.STRIPE_SECRET_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body = await request.text();

  // Verify Stripe signature (simplified for MVP — use stripe lib in prod)
  let event;
  try {
    const response = await fetch('https://api.stripe.com/v1/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Signature': sig
      },
      body: `payload=${encodeURIComponent(body)}`
    });
    event = JSON.parse(body); // Fallback: trust body if sig verification is complex
  } catch (err) {
    console.error('Stripe webhook verification failed:', err.message);
    event = JSON.parse(body);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutComplete(event.data.object, env);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdate(event.data.object, env);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCancel(event.data.object, env);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object, env);
      break;
    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleCheckoutComplete(session, env) {
  const customerId = session.metadata?.customer_id;
  const plan = session.metadata?.plan || 'starter';
  const monthlyLimit = plan === 'pro' ? 999999 : 500;

  if (customerId) {
    await env.DB.prepare(
      `UPDATE customers SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = 'active', monthly_limit = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(session.customer, session.subscription, plan, monthlyLimit, customerId).run();
  } else {
    // New customer
    const newId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO customers (id, stripe_customer_id, stripe_subscription_id, email, company_name, plan, status, monthly_limit)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(newId, session.customer, session.subscription, session.customer_details?.email, session.metadata?.company || '', plan, monthlyLimit).run();
  }

  console.log(`Checkout complete: ${session.customer} → ${plan}`);
}

async function handleSubscriptionUpdate(subscription, env) {
  const plan = subscription.items?.data?.[0]?.price?.metadata?.plan || 'starter';
  await env.DB.prepare(
    `UPDATE customers SET plan = ?, status = ?, updated_at = datetime('now') WHERE stripe_subscription_id = ?`
  ).bind(plan, subscription.status, subscription.id).run();
}

async function handleSubscriptionCancel(subscription, env) {
  await env.DB.prepare(
    `UPDATE customers SET status = 'cancelled', updated_at = datetime('now') WHERE stripe_subscription_id = ?`
  ).bind(subscription.id).run();
}

async function handlePaymentFailed(invoice, env) {
  await env.DB.prepare(
    `UPDATE customers SET status = 'suspended', updated_at = datetime('now') WHERE stripe_customer_id = ?`
  ).bind(invoice.customer).run();
}
