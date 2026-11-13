/**
 * EdgeIQ DNS Firewall — Stripe Webhook Handler
 * Raw crypto.subtle signature verification (no SDK)
 */

async function verifyStripeSignature(body, sig, secret) {
  const parts = sig.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
  const signature = parts.find(p => p.startsWith('v1='))?.split('=')[1];
  if (!timestamp || !signature) return null;
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

const TIER_LIMITS = {
  free: { max_devices: 1, max_blocklists: 3, custom_allowlist: 0, real_time_alerts: 0 },
  personal: { max_devices: 10, max_blocklists: 10, custom_allowlist: 1, real_time_alerts: 0 },
  business: { max_devices: 999, max_blocklists: 999, custom_allowlist: 1, real_time_alerts: 1 },
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  if (!sig) return new Response('Missing stripe-signature header', { status: 400 });
  if (!env.DNSFW_WEBHOOK_SECRET) {
    console.error('DNSFW_WEBHOOK_SECRET not configured');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  const event = await verifyStripeSignature(body, sig, env.DNSFW_WEBHOOK_SECRET);
  if (!event) return new Response('Invalid signature', { status: 400 });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_email || session.customer_details?.email;
        const plan = session.metadata?.plan || 'personal';
        const customerId = session.customer;

        if (email && customerId) {
          const id = crypto.randomUUID();
          const limits = TIER_LIMITS[plan] || TIER_LIMITS.personal;

          await env.DNSFW_DB.prepare(
            'INSERT OR IGNORE INTO dnsfw_customers (id, email, stripe_customer_id, tier, max_devices, max_blocklists, custom_allowlist, real_time_alerts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(id, email, customerId, plan, limits.max_devices, limits.max_blocklists, limits.custom_allowlist, limits.real_time_alerts).run();

          // Seed default blocklists
          const defaultLists = [
            { name: 'AdGuard DNS Filter', category: 'ads', source_url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt' },
            { name: 'OISD Big', category: 'ads', source_url: 'https://big.oisd.nl/domainswild' },
            { name: 'Malware Domain List', category: 'malware', source_url: 'https://www.malwaredomainlist.com/hostslist/hosts.txt' },
          ];
          for (const bl of defaultLists) {
            await env.DNSFW_DB.prepare(
              'INSERT OR IGNORE INTO dnsfw_blocklists (id, customer_id, name, category, source_url) VALUES (?, ?, ?, ?, ?)'
            ).bind(crypto.randomUUID(), id, bl.name, bl.category, bl.source_url).run();
          }

          // Send welcome email
          if (env.RESEND_API_KEY) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
                to: [email],
                subject: 'Your DNS Firewall is active',
                html: `<h2>DNS Firewall Active</h2><p>Your ${plan} plan is live.</p><p>Dashboard: <a href="https://edgeiqlabs.com/dnsfirewall/dashboard/">edgeiqlabs.com/dnsfirewall/dashboard</a></p><p>Point your router DNS to our resolvers to start blocking threats.</p>`
              })
            });
          }

          console.log(`DNSFirewall: Provisioned ${plan} for ${email}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const amount = sub.items?.data?.[0]?.price?.unit_amount;
        const plan = amount === 500 ? 'personal' : amount === 1900 ? 'business' : 'personal';
        const limits = TIER_LIMITS[plan] || TIER_LIMITS.personal;

        await env.DNSFW_DB.prepare(
          'UPDATE dnsfw_customers SET tier = ?, max_devices = ?, max_blocklists = ?, custom_allowlist = ?, real_time_alerts = ?, updated_at = datetime("now") WHERE stripe_customer_id = ?'
        ).bind(plan, limits.max_devices, limits.max_blocklists, limits.custom_allowlist, limits.real_time_alerts, customerId).run();

        console.log(`DNSFirewall: Updated ${customerId} to ${plan}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        await env.DNSFW_DB.prepare(
          'UPDATE dnsfw_customers SET tier = "free", max_devices = 1, max_blocklists = 3, custom_allowlist = 0, real_time_alerts = 0, updated_at = datetime("now") WHERE stripe_customer_id = ?'
        ).bind(customerId).run();

        console.log(`DNSFirewall: Downgraded ${customerId} to free`);
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('DNSFirewall webhook error:', e);
    return new Response('Handler error', { status: 500 });
  }
}
