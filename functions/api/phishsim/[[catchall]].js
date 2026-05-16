/**
 * EdgeIQ PhishSim — API Worker
 * Deploy as Cloudflare Pages Function at /api/phishsim/*
 *
 * Env vars required:
 *   PHISHSIM_SECRET        — shared secret for the R720 management API
 *   PHISHSIM_MGR_URL       — https://phishsim-api.edgeiqlabs.com
 *   PHISHSIM_KV            — KV namespace binding for customer instance data
 *   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (set after /setup runs)
 *   PHISHSIM_PRICE_ID      — Stripe price ID for PhishSim subscription (set after /setup runs)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Customer-ID, X-Stripe-Signature, X-Provision-Secret',
};

const SITE_URL = 'https://edgeiqlabs.com';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Manager API helper ────────────────────────────────────────────────────────

async function mgr(env, path, method = 'GET', body = null) {
  const resp = await fetch(`${env.PHISHSIM_MGR_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.PHISHSIM_SECRET}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try { return { status: resp.status, data: JSON.parse(text) }; }
  catch { return { status: resp.status, data: { raw: text } }; }
}

// ── GoPhish proxy helper ──────────────────────────────────────────────────────

async function gophishProxy(env, customerId, gophishPath, method = 'GET', body = null) {
  const url = `${env.PHISHSIM_MGR_URL}/proxy/${customerId}/${gophishPath}`;
  const resp = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${env.PHISHSIM_SECRET}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try { return { status: resp.status, data: JSON.parse(text) }; }
  catch { return { status: resp.status, data: { raw: text } }; }
}

// ── Welcome email ─────────────────────────────────────────────────────────────

async function sendWelcomeEmail(env, email, customerId) {
  if (!env.RESEND_API_KEY || !email) return;
  const dashUrl = `${SITE_URL}/phishsim/?cid=${encodeURIComponent(customerId)}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'EdgeIQ PhishSim <phishsim@edgeiqlabs.com>',
      to: [email],
      subject: 'Your PhishSim Customer ID — Save This',
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0b0f14;color:#e8eef7;padding:36px;border-radius:14px;">
  <h1 style="font-size:1.4rem;margin:0 0 8px;">🎣 PhishSim is ready</h1>
  <p style="color:#9fb0c7;margin:0 0 28px;line-height:1.6;">Your phishing simulation platform has been provisioned. Save your Customer ID below — you'll need it every time you log in.</p>
  <div style="background:#0f1620;border:1px solid #3dd9ff;border-radius:10px;padding:18px 20px;margin-bottom:28px;">
    <div style="font-size:0.68rem;color:#3dd9ff;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Customer ID</div>
    <div style="font-family:monospace;font-size:0.88rem;word-break:break-all;color:#e8eef7;">${customerId}</div>
  </div>
  <a href="${dashUrl}" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;font-size:0.9rem;padding:13px 28px;border-radius:8px;text-decoration:none;">Open Dashboard →</a>
  <p style="color:#4a6080;font-size:0.75rem;margin:28px 0 0;line-height:1.6;">Questions? Email <a href="mailto:support@edgeiqlabs.com" style="color:#9fb0c7;">support@edgeiqlabs.com</a> — we reply within a few hours.</p>
</div>`,
    }),
  }).catch(() => {});
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function getCustomerInstance(env, customerId) {
  const raw = await env.PHISHSIM_KV.get(`instance:${customerId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveCustomerInstance(env, customerId, data) {
  await env.PHISHSIM_KV.put(`instance:${customerId}`, JSON.stringify(data));
}

// ── Stripe helpers ────────────────────────────────────────────────────────────

async function stripeRequest(env, path, method = 'GET', params = null) {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization':  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  return resp.json();
}

// ── Stripe signature verification ─────────────────────────────────────────────

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts     = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('='); acc[k] = v; return acc;
  }, {});
  const timestamp = parts['t'];
  const sig       = parts['v1'];
  const signed    = `${timestamp}.${payload}`;
  const key  = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const hex  = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === sig;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe not configured' }, 500);

  let body = {};
  try { body = await request.json(); } catch {}

  // Generate a stable customer ID for this purchase
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  const customerId = 'ps_' + [...arr].map(b => b.toString(16).padStart(2, '0')).join('');

  const priceId = env.PHISHSIM_PRICE_ID;
  if (!priceId) return json({ error: 'PhishSim pricing not configured — run /api/phishsim/setup first' }, 500);

  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id: customerId,
    success_url: `${SITE_URL}/welcome/phishsim/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_URL}/services.html`,
  };
  if (body.email) params.customer_email = body.email;

  const session = await stripeRequest(env, '/checkout/sessions', 'POST', params);
  if (!session.url) return json({ error: 'Failed to create checkout session', detail: session }, 502);

  return json({ checkoutUrl: session.url, customerId });
}

async function handleSession(request, env) {
  // Resolves a Stripe checkout session_id → customer info + auto-provisions
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('id');
  if (!sessionId) return json({ error: 'session id required' }, 400);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe not configured' }, 500);

  const session = await stripeRequest(env, `/checkout/sessions/${sessionId}`);
  if (!session.id) return json({ error: 'Invalid session' }, 404);

  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return json({ error: 'Payment not complete', status: session.payment_status }, 402);
  }

  const customerId = session.client_reference_id || session.customer || session.id;
  const email      = session.customer_details?.email || session.customer_email || '';

  // Check if already provisioned
  let inst = await getCustomerInstance(env, customerId);
  if (!inst) {
    // Provision now (webhook may not have fired yet)
    const { status, data } = await mgr(env, '/provision', 'POST', { customer_id: customerId });
    if (status === 200 || status === 201) {
      inst = { ...data, email, _emailSent: false };
      await saveCustomerInstance(env, customerId, inst);
    } else {
      return json({ error: 'Provisioning failed — try again in a moment', detail: data }, 500);
    }
  }

  // Send welcome email exactly once
  if (!inst._emailSent) {
    await sendWelcomeEmail(env, email || inst.email, customerId);
    inst._emailSent = true;
    await saveCustomerInstance(env, customerId, inst);
  }

  return json({ customerId, email: email || inst.email, ...inst });
}

async function handleSetup(request, env) {
  // One-time admin route: creates Stripe product/price + webhook endpoint
  // Requires X-Provision-Secret header
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'STRIPE_SECRET_KEY not set' }, 500);

  const results = {};

  // 1. Create or find product
  const product = await stripeRequest(env, '/products', 'POST', {
    name: 'EdgeIQ PhishSim',
    description: 'Phishing simulation platform — train your team before attackers do',
    'metadata[service]': 'phishsim',
  });
  results.product_id = product.id;

  // 2. Create monthly recurring price at $49/month
  const price = await stripeRequest(env, '/prices', 'POST', {
    product: product.id,
    unit_amount: '4900',
    currency: 'usd',
    'recurring[interval]': 'month',
    nickname: 'PhishSim Starter Monthly',
  });
  results.price_id = price.id;

  // 3. Register Stripe webhook endpoint
  const hook = await stripeRequest(env, '/webhook_endpoints', 'POST', {
    url: `${SITE_URL}/api/phishsim/stripe-webhook`,
    'enabled_events[]': 'checkout.session.completed',
    description: 'EdgeIQ PhishSim auto-provisioning',
  });
  results.webhook_id     = hook.id;
  results.webhook_secret = hook.secret;

  results.instructions = [
    `Set PHISHSIM_PRICE_ID=${price.id} in Cloudflare Pages env vars`,
    `Set STRIPE_WEBHOOK_SECRET=${hook.secret} in Cloudflare Pages env vars`,
    'Then redeploy Pages for the new vars to take effect',
  ];

  return json(results, 201);
}

async function handleProvision(request, env) {
  const body       = await request.json();
  const customerId = body.customer_id;
  if (!customerId) return json({ error: 'customer_id required' }, 400);

  const existing = await getCustomerInstance(env, customerId);
  if (existing) return json({ status: 'exists', ...existing });

  const { status, data } = await mgr(env, '/provision', 'POST', { customer_id: customerId });
  if (status !== 201 && status !== 200) {
    return json({ error: data.error || 'Provisioning failed' }, 500);
  }

  await saveCustomerInstance(env, customerId, data);
  return json({ status: 'provisioned', ...data }, 201);
}

async function handleStripeWebhook(request, env) {
  const payload   = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  if (env.STRIPE_WEBHOOK_SECRET) {
    const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return json({ error: 'Invalid signature' }, 400);
  }

  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'Bad JSON' }, 400); }

  if (event.type === 'checkout.session.completed') {
    const session    = event.data.object;
    const customerId = session.client_reference_id || session.customer || session.id;
    const email      = session.customer_details?.email || '';

    const { status, data } = await mgr(env, '/provision', 'POST', { customer_id: customerId });
    if (status === 201 || status === 200) {
      await saveCustomerInstance(env, customerId, { ...data, email, _emailSent: false });
      await sendWelcomeEmail(env, email, customerId);
      await saveCustomerInstance(env, customerId, { ...data, email, _emailSent: true });
    }
  }

  return json({ received: true });
}

async function handleCampaigns(request, env, customerId, campaignId = null) {
  const method = request.method;
  let path     = 'campaigns/';
  if (campaignId) path += `${campaignId}${method === 'GET' ? '/results' : ''}`;

  let body = null;
  if (method === 'POST') { try { body = await request.json(); } catch {} }

  const { status, data } = await gophishProxy(env, customerId, path, method, body);
  return json(data, status);
}

async function handleTemplates(request, env, customerId, templateId = null) {
  const method = request.method;
  const path   = templateId ? `templates/${templateId}` : 'templates/';
  let body = null;
  if (method === 'POST' || method === 'PUT') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, path, method, body);
  return json(data, status);
}

async function handleGroups(request, env, customerId, groupId = null) {
  const method = request.method;
  const path   = groupId ? `groups/${groupId}` : 'groups/';
  let body = null;
  if (method === 'POST' || method === 'PUT') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, path, method, body);
  return json(data, status);
}

async function handleSendingProfiles(request, env, customerId, profileId = null) {
  const method = request.method;
  let path = profileId ? `smtp/${profileId}` : 'smtp/';
  let body = null;
  if (method === 'POST' || method === 'PUT') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, path, method, body);
  return json(data, status);
}

async function handlePages(request, env, customerId, pageId = null) {
  const method = request.method;
  let path = pageId ? `pages/${pageId}` : 'pages/';
  let body = null;
  if (method === 'POST' || method === 'PUT') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, path, method, body);
  return json(data, status);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url        = new URL(request.url);
  const segments   = url.pathname.replace(/^\/api\/phishsim\/?/, '').split('/').filter(Boolean);
  const resource   = segments[0] || '';
  const resourceId = segments[1] || null;

  // ── Public / admin routes ──────────────────────────────────────────────────

  if (resource === 'stripe-webhook' && request.method === 'POST') {
    return handleStripeWebhook(request, env);
  }

  if (resource === 'checkout' && request.method === 'POST') {
    return handleCheckout(request, env);
  }

  if (resource === 'session' && request.method === 'GET') {
    return handleSession(request, env);
  }

  // Admin-only routes require the provision secret
  const secret = request.headers.get('X-Provision-Secret');
  const isAdmin = secret === env.PHISHSIM_SECRET;

  if (resource === 'provision' && request.method === 'POST') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    return handleProvision(request, env);
  }

  if (resource === 'setup' && request.method === 'POST') {
    if (!isAdmin) return json({ error: 'Forbidden' }, 403);
    return handleSetup(request, env);
  }

  // ── Customer routes — require X-Customer-ID ────────────────────────────────

  const customerId = request.headers.get('X-Customer-ID');
  if (!customerId) return json({ error: 'X-Customer-ID header required' }, 401);

  const inst = await getCustomerInstance(env, customerId);
  if (!inst && resource !== 'instance') {
    return json({ error: 'No PhishSim instance found. Please contact support.' }, 404);
  }

  switch (resource) {
    case 'instance':
      if (inst) return json(inst);
      return json({ error: 'Not provisioned' }, 404);

    case 'campaigns':
      return handleCampaigns(request, env, customerId, resourceId);

    case 'templates':
      return handleTemplates(request, env, customerId, resourceId);

    case 'groups':
      return handleGroups(request, env, customerId, resourceId);

    case 'smtp':
      return handleSendingProfiles(request, env, customerId, resourceId);

    case 'pages':
      return handlePages(request, env, customerId, resourceId);

    default:
      return json({ error: 'Not found' }, 404);
  }
}
