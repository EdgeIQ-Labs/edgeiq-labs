/**
 * EdgeIQ StatusPage — Stripe Webhook Handler
 * Route: /api/statuspage/webhook
 * Uses raw crypto.subtle for signature verification (no Stripe SDK)
 */

async function verifyStripeSignature(body, sig, secret) {
  const parts = sig.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
  const signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];
  if (!timestamp || !signature) return null;

  // Reject if timestamp is >5 min old
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return null;

  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

  return expected === signature ? JSON.parse(body) : null;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  if (env.STATUSPAGE_WEBHOOK_SECRET && sig) {
    event = await verifyStripeSignature(body, sig, env.STATUSPAGE_WEBHOOK_SECRET);
    if (!event) return new Response('Invalid signature', { status: 400 });
  } else {
    try { event = JSON.parse(body); } catch { return new Response('Invalid payload', { status: 400 }); }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        const plan = session.metadata?.plan || 'starter';
        const customerId = session.customer;

        if (email && customerId) {
          const slug = email.split('@')[0].replace(/[^a-z0-9]/g, '-').slice(0, 30) + '-' + Date.now().toString(36);
          const pageId = crypto.randomUUID();

          await env.STATUSPAGE_DB.prepare(
            'INSERT OR IGNORE INTO pages (id, slug, name, owner_email, stripe_customer_id, tier) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(pageId, slug, 'My Status Page', email, customerId, plan).run();

          // Send welcome email via Resend
          if (env.RESEND_API_KEY) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
                to: [email],
                subject: 'Your StatusPage is ready',
                html: `<h2>Welcome to EdgeIQ StatusPage</h2><p>Your status page is live at <a href="https://edgeiqlabs.com/s/${slug}">edgeiqlabs.com/s/${slug}</a></p><p>Manage it from your <a href="https://edgeiqlabs.com/statuspage/dashboard/">dashboard</a>.</p><p>Plan: ${plan} ($${plan === 'starter' ? '9' : plan === 'pro' ? '19' : '49'}/mo)</p>`
              })
            });
          }

          console.log(`StatusPage: Created page ${slug} for ${email} (${plan})`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const amount = sub.items?.data?.[0]?.price?.unit_amount;
        const plan = amount === 900 ? 'starter' : amount === 1900 ? 'pro' : amount === 4900 ? 'business' : 'starter';

        await env.STATUSPAGE_DB.prepare(
          'UPDATE pages SET tier = ?, updated_at = datetime("now") WHERE stripe_customer_id = ?'
        ).bind(plan, customerId).run();

        console.log(`StatusPage: Updated tier to ${plan} for ${customerId}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        await env.STATUSPAGE_DB.prepare(
          'UPDATE pages SET tier = "free", updated_at = datetime("now") WHERE stripe_customer_id = ?'
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
