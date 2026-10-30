/**
 * CertWatch API — SSL Certificate Expiry Monitor
 * Endpoints:
 *   POST /api/certwatch/domains     — Add domain (requires auth)
 *   DELETE /api/certwatch/domains/:domain — Remove domain (requires auth)
 *   GET  /api/certwatch/domains     — List monitored domains (requires auth)
 *   POST /api/certwatch/check       — Manual check for a domain (free, no auth)
 *   POST /api/certwatch/webhook     — Stripe webhook handler
 *
 * Cron trigger: daily at 6AM ET, checks all monitored certs
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Check SSL cert for a single domain using CF's built-in fetch
async function checkCert(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const resp = await fetch(`https://${domain}`, {
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    
    // CF Workers expose certificate info on the response
    // Unfortunately, CF Workers don't expose cert details directly.
    // We need to use a different approach: connect via TLS and read cert.
    // For now, use the existing ssl-checker worker endpoint.
    return null; // Will be replaced with actual check logic
  } catch (e) {
    return { error: e.message, domain };
  }
}

// Use the existing SSL checker infrastructure
async function checkCertViaWorker(domain, env) {
  try {
    // Call our own SSL checker API
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
    
    // Parse expiry from the SSL checker response
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
    
    const result = await checkCertViaWorker(domain, env);
    return json(result);
  }

  // All other endpoints require authentication
  // For MVP: simple email-based auth via query param or header
  // TODO: Replace with proper JWT/session auth
  const authEmail = request.headers.get('X-CertWatch-Email') || url.searchParams.get('email');
  
  if (!authEmail) {
    return json({ error: 'Authentication required. Pass X-CertWatch-Email header.' }, 401);
  }

  // Get or create subscriber
  let subscriber = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(authEmail).first();
  
  if (!subscriber) {
    // Free tier: allow 1 domain without subscription
    await env.DB.prepare('INSERT INTO subscribers (email, max_domains) VALUES (?, 1)').bind(authEmail).run();
    subscriber = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(authEmail).first();
  }

  // Route: GET /domains — List monitored domains
  if (path === '/domains' && method === 'GET') {
    const domains = await env.DB.prepare(
      'SELECT * FROM monitored_domains WHERE subscriber_id = ? ORDER BY added_at DESC'
    ).bind(subscriber.id).all();
    
    return json({ 
      domains: domains.results, 
      max_domains: subscriber.max_domains,
      count: domains.results.length 
    });
  }

  // Route: POST /domains — Add domain
  if (path === '/domains' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const domain = (body.domain || '').trim().toLowerCase();
    
    if (!domain || !domain.includes('.')) {
      return json({ error: 'Valid domain required' }, 400);
    }
    
    // Check domain limit
    const countResult = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM monitored_domains WHERE subscriber_id = ?'
    ).bind(subscriber.id).first();
    
    if (countResult.cnt >= subscriber.max_domains) {
      return json({ 
        error: `Domain limit reached (${subscriber.max_domains}). Upgrade to add more.`,
        upgrade_url: 'https://buy.stripe.com/cNi9AV8dZ7hb3jS2cg7wB2v'
      }, 403);
    }
    
    // Check for duplicate
    const existing = await env.DB.prepare(
      'SELECT id FROM monitored_domains WHERE subscriber_id = ? AND domain = ?'
    ).bind(subscriber.id, domain).first();
    
    if (existing) {
      return json({ error: 'Domain already monitored' }, 409);
    }
    
    // Add domain
    await env.DB.prepare(
      'INSERT INTO monitored_domains (subscriber_id, domain) VALUES (?, ?)'
    ).bind(subscriber.id, domain).run();
    
    // Do initial check
    const checkResult = await checkCertViaWorker(domain, env);
    
    if (checkResult.status !== 'error') {
      await env.DB.prepare(
        'UPDATE monitored_domains SET last_checked_at = ?, last_expiry_date = ?, last_issuer = ?, last_status = ? WHERE subscriber_id = ? AND domain = ?'
      ).bind(
        new Date().toISOString(),
        checkResult.expiry_date,
        checkResult.issuer,
        checkResult.status,
        subscriber.id,
        domain
      ).run();
    }
    
    return json({ success: true, domain, check: checkResult }, 201);
  }

  // Route: DELETE /domains/:domain — Remove domain
  if (path.startsWith('/domains/') && method === 'DELETE') {
    const domain = decodeURIComponent(path.replace('/domains/', '')).toLowerCase();
    
    await env.DB.prepare(
      'DELETE FROM monitored_domains WHERE subscriber_id = ? AND domain = ?'
    ).bind(subscriber.id, domain).run();
    
    return json({ success: true, removed: domain });
  }

  // Route: POST /webhook — Stripe webhook
  if (path === '/webhook' && method === 'POST') {
    // TODO: Verify Stripe signature
    const event = await request.json().catch(() => ({}));
    
    if (event.type === 'checkout.session.completed') {
      const customerEmail = event.data?.object?.customer_details?.email;
      const subscriptionId = event.data?.object?.subscription;
      const customerId = event.data?.object?.customer;
      
      if (customerEmail) {
        await env.DB.prepare(
          'UPDATE subscribers SET stripe_customer_id = ?, stripe_subscription_id = ?, status = ?, max_domains = 25, updated_at = datetime("now") WHERE email = ?'
        ).bind(customerId, subscriptionId, 'active', customerEmail).run();
        
        // If subscriber doesn't exist yet, create them
        const exists = await env.DB.prepare('SELECT id FROM subscribers WHERE email = ?').bind(customerEmail).first();
        if (!exists) {
          await env.DB.prepare(
            'INSERT INTO subscribers (email, stripe_customer_id, stripe_subscription_id, status, max_domains) VALUES (?, ?, ?, ?, 25)'
          ).bind(customerEmail, customerId, subscriptionId, 'active').run();
        }
      }
    }
    
    if (event.type === 'customer.subscription.updated') {
      const subscriptionId = event.data?.object?.id;
      const status = event.data?.object?.status;
      
      await env.DB.prepare(
        'UPDATE subscribers SET status = ?, updated_at = datetime("now") WHERE stripe_subscription_id = ?'
      ).bind(status, subscriptionId).run();
    }
    
    if (event.type === 'customer.subscription.deleted') {
      const subscriptionId = event.data?.object?.id;
      
      await env.DB.prepare(
        'UPDATE subscribers SET status = ?, max_domains = 1, updated_at = datetime("now") WHERE stripe_subscription_id = ?'
      ).bind('cancelled', subscriptionId).run();
    }
    
    return json({ received: true });
  }

  return json({ error: 'Not found' }, 404);
}
