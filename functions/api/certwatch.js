/**
 * CertWatch API — SSL Certificate Expiry Monitor (KV-backed)
 * Uses PULSE_KV for storage to match existing EdgeIQ architecture.
 *
 * KV Key Schema:
 *   certwatch:sub:{email}          → subscriber JSON
 *   certwatch:domains:{email}      → JSON array of domain objects
 *
 * Endpoints:
 *   POST /api/certwatch/domains     — Add domain (requires auth)
 *   DELETE /api/certwatch/domains/:domain — Remove domain (requires auth)
 *   GET  /api/certwatch/domains     — List monitored domains (requires auth)
 *   POST /api/certwatch/check       — Manual check for a domain (free, no auth)
 *   POST /api/certwatch/webhook     — Stripe webhook handler
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CertWatch-Email',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ─── KV Helpers ────────────────────────────────────────────────
async function getSubscriber(env, email) {
  const raw = await env.PULSE_KV.get(`certwatch:sub:${email}`);
  return raw ? JSON.parse(raw) : null;
}

async function putSubscriber(env, email, data) {
  await env.PULSE_KV.put(`certwatch:sub:${email}`, JSON.stringify(data));
}

async function getDomains(env, email) {
  const raw = await env.PULSE_KV.get(`certwatch:domains:${email}`);
  return raw ? JSON.parse(raw) : [];
}

async function putDomains(env, email, domains) {
  await env.PULSE_KV.put(`certwatch:domains:${email}`, JSON.stringify(domains));
}

// ─── SSL Check via existing infrastructure ─────────────────────
async function checkCertViaWorker(domain) {
  try {
    const resp = await fetch('https://edgeiqlabs.com/api/ssl-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    if (!resp.ok) {
      return { domain, status: 'error', error: `API returned ${resp.status}` };
    }

    const data = await resp.json();

    if (data.error) {
      return { domain, status: 'error', error: data.error };
    }

    const expiryDate = data.expiry || data.validTo || data.notAfter;
    const issuer = data.issuer || data.organization || 'Unknown';

    if (!expiryDate) {
      return { domain, status: 'error', error: 'No expiry date in response' };
    }

    const expiry = new Date(expiryDate);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    let status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    return {
      domain,
      status,
      expiry_date: expiry.toISOString(),
      days_until_expiry: daysUntilExpiry,
      issuer,
    };
  } catch (e) {
    return { domain, status: 'error', error: e.message };
  }
}

// ─── Request Handler ───────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/certwatch', '');
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Route: POST /check — Free manual check (no auth)
  if (path === '/check' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const domain = (body.domain || '').trim().toLowerCase();

    if (!domain || !domain.includes('.')) {
      return json({ error: 'Valid domain required' }, 400);
    }

    const result = await checkCertViaWorker(domain);
    return json(result);
  }

  // All other endpoints require authentication
  const authEmail = (request.headers.get('X-CertWatch-Email') || url.searchParams.get('email') || '').trim().toLowerCase();

  if (!authEmail || !authEmail.includes('@')) {
    return json({ error: 'Authentication required. Pass X-CertWatch-Email header.' }, 401);
  }

  // Get or create subscriber
  let subscriber = await getSubscriber(env, authEmail);

  if (!subscriber) {
    // Free tier: 1 domain, no subscription
    subscriber = {
      email: authEmail,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      status: 'free',
      max_domains: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await putSubscriber(env, authEmail, subscriber);
  }

  // Route: GET /domains — List monitored domains
  if (path === '/domains' && method === 'GET') {
    const domains = await getDomains(env, authEmail);
    return json({
      domains,
      max_domains: subscriber.max_domains,
      count: domains.length,
      status: subscriber.status,
    });
  }

  // Route: POST /domains — Add domain
  if (path === '/domains' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const domain = (body.domain || '').trim().toLowerCase();

    if (!domain || !domain.includes('.')) {
      return json({ error: 'Valid domain required' }, 400);
    }

    const domains = await getDomains(env, authEmail);

    // Check domain limit
    if (domains.length >= subscriber.max_domains) {
      return json({
        error: `Domain limit reached (${subscriber.max_domains}). Upgrade to add more.`,
        upgrade_url: 'https://buy.stripe.com/cNi9AV8dZ7hb3jS2cg7wB2v',
      }, 403);
    }

    // Check for duplicate
    if (domains.some(d => d.domain === domain)) {
      return json({ error: 'Domain already monitored' }, 409);
    }

    // Do initial check
    const checkResult = await checkCertViaWorker(domain);

    const newDomain = {
      domain,
      added_at: new Date().toISOString(),
      last_checked_at: checkResult.status !== 'error' ? new Date().toISOString() : null,
      last_expiry_date: checkResult.expiry_date || null,
      last_issuer: checkResult.issuer || null,
      last_status: checkResult.status || 'error',
      last_days_until_expiry: checkResult.days_until_expiry ?? null,
    };

    domains.push(newDomain);
    await putDomains(env, authEmail, domains);

    return json({ success: true, domain: newDomain, check: checkResult }, 201);
  }

  // Route: DELETE /domains/:domain — Remove domain
  if (path.startsWith('/domains/') && method === 'DELETE') {
    const domain = decodeURIComponent(path.replace('/domains/', '')).toLowerCase();
    const domains = await getDomains(env, authEmail);
    const filtered = domains.filter(d => d.domain !== domain);

    if (filtered.length === domains.length) {
      return json({ error: 'Domain not found' }, 404);
    }

    await putDomains(env, authEmail, filtered);
    return json({ success: true, removed: domain });
  }

  // Route: POST /webhook — Stripe webhook
  if (path === '/webhook' && method === 'POST') {
    const event = await request.json().catch(() => ({}));

    if (event.type === 'checkout.session.completed') {
      const customerEmail = (event.data?.object?.customer_details?.email || '').toLowerCase();
      const subscriptionId = event.data?.object?.subscription;
      const customerId = event.data?.object?.customer;

      if (customerEmail) {
        let sub = await getSubscriber(env, customerEmail);
        if (sub) {
          sub.stripe_customer_id = customerId;
          sub.stripe_subscription_id = subscriptionId;
          sub.status = 'active';
          sub.max_domains = 25;
          sub.updated_at = new Date().toISOString();
        } else {
          sub = {
            email: customerEmail,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            status: 'active',
            max_domains: 25,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        await putSubscriber(env, customerEmail, sub);
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const subscriptionId = event.data?.object?.id;
      const status = event.data?.object?.status;
      const customerEmail = (event.data?.object?.metadata?.email || '').toLowerCase();

      if (customerEmail) {
        const sub = await getSubscriber(env, customerEmail);
        if (sub && sub.stripe_subscription_id === subscriptionId) {
          sub.status = status;
          sub.updated_at = new Date().toISOString();
          await putSubscriber(env, customerEmail, sub);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscriptionId = event.data?.object?.id;
      const customerEmail = (event.data?.object?.metadata?.email || '').toLowerCase();

      if (customerEmail) {
        const sub = await getSubscriber(env, customerEmail);
        if (sub && sub.stripe_subscription_id === subscriptionId) {
          sub.status = 'cancelled';
          sub.max_domains = 1;
          sub.updated_at = new Date().toISOString();
          await putSubscriber(env, customerEmail, sub);
        }
      }
    }

    return json({ received: true });
  }

  return json({ error: 'Not found' }, 404);
}
