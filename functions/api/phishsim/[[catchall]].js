/**
 * EdgeIQ PhishSim — API Worker
 * Deploy as Cloudflare Pages Function at /api/phishsim/*
 *
 * Env vars required:
 *   PHISHSIM_SECRET   — shared secret for the R720 management API
 *   PHISHSIM_MGR_URL  — https://phishsim-api.edgeiqlabs.com
 *   PHISHSIM_KV       — KV namespace binding for customer instance data
 *
 * Routes:
 *   POST   /api/phishsim/provision          — called by Stripe success webhook
 *   GET    /api/phishsim/instance           — return instance info for authenticated customer
 *   GET    /api/phishsim/campaigns          — list campaigns
 *   POST   /api/phishsim/campaigns          — create campaign
 *   GET    /api/phishsim/campaigns/:id      — get campaign + results
 *   DELETE /api/phishsim/campaigns/:id      — delete campaign
 *   GET    /api/phishsim/templates          — list email templates
 *   POST   /api/phishsim/templates          — create template
 *   GET    /api/phishsim/groups             — list target groups
 *   POST   /api/phishsim/groups             — create target group
 *   POST   /api/phishsim/stripe-webhook     — Stripe webhook (provision on payment)
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Customer-ID, X-Stripe-Signature',
};

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

// ── KV helpers ────────────────────────────────────────────────────────────────

async function getCustomerInstance(env, customerId) {
  const raw = await env.PHISHSIM_KV.get(`instance:${customerId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveCustomerInstance(env, customerId, data) {
  await env.PHISHSIM_KV.put(`instance:${customerId}`, JSON.stringify(data));
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

async function handleProvision(request, env) {
  const body       = await request.json();
  const customerId = body.customer_id;
  if (!customerId) return json({ error: 'customer_id required' }, 400);

  // Check if already provisioned
  const existing = await getCustomerInstance(env, customerId);
  if (existing) return json({ status: 'exists', ...existing });

  // Provision via management API
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

    // Provision the GoPhish instance
    const { status, data } = await mgr(env, '/provision', 'POST', { customer_id: customerId });
    if (status === 201 || status === 200) {
      await saveCustomerInstance(env, customerId, { ...data, email });
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

async function handleTemplates(request, env, customerId) {
  const method = request.method;
  let body = null;
  if (method === 'POST') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, 'templates/', method, body);
  return json(data, status);
}

async function handleGroups(request, env, customerId) {
  const method = request.method;
  let body = null;
  if (method === 'POST') { try { body = await request.json(); } catch {} }
  const { status, data } = await gophishProxy(env, customerId, 'groups/', method, body);
  return json(data, status);
}

async function handleSendingProfiles(request, env, customerId) {
  const { status, data } = await gophishProxy(env, customerId, 'smtp/', 'GET');
  return json(data, status);
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url      = new URL(request.url);
  const segments = url.pathname.replace(/^\/api\/phishsim\/?/, '').split('/').filter(Boolean);
  const resource = segments[0] || '';
  const resourceId = segments[1] || null;

  // Public routes (no customer auth needed)
  if (resource === 'provision' && request.method === 'POST') {
    // Require internal secret header for direct provision calls
    const secret = request.headers.get('X-Provision-Secret');
    if (secret !== env.PHISHSIM_SECRET) return json({ error: 'Forbidden' }, 403);
    return handleProvision(request, env);
  }

  if (resource === 'stripe-webhook' && request.method === 'POST') {
    return handleStripeWebhook(request, env);
  }

  // All other routes require a customer ID
  const customerId = request.headers.get('X-Customer-ID');
  if (!customerId) return json({ error: 'X-Customer-ID header required' }, 401);

  // Validate customer has a provisioned instance
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
      return handleTemplates(request, env, customerId);

    case 'groups':
      return handleGroups(request, env, customerId);

    case 'smtp':
      return handleSendingProfiles(request, env, customerId);

    default:
      return json({ error: 'Not found' }, 404);
  }
}
