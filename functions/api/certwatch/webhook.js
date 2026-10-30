const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CertWatch-Email',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function getSubscriber(env, email) {
  var raw = await env.PULSE_KV.get('certwatch:sub:' + email);
  return raw ? JSON.parse(raw) : null;
}

async function putSubscriber(env, email, data) {
  await env.PULSE_KV.put('certwatch:sub:' + email, JSON.stringify(data));
}

async function getDomains(env, email) {
  var raw = await env.PULSE_KV.get('certwatch:domains:' + email);
  return raw ? JSON.parse(raw) : [];
}

async function putDomains(env, email, domains) {
  await env.PULSE_KV.put('certwatch:domains:' + email, JSON.stringify(domains));
}

async function checkCertViaWorker(domain) {
  try {
    var resp = await fetch('https://edgeiqlabs.com/api/cert-expiry?domain=' + encodeURIComponent(domain));
    if (!resp.ok) return { domain: domain, status: 'error', error: 'cert-expiry returned ' + resp.status };
    var data = await resp.json();
    if (data.error || data.status === 'error') return { domain: domain, status: 'error', error: data.error || 'Check failed' };
    return { domain: domain, status: data.status || 'valid', expiry_date: data.expiry_date, days_until_expiry: data.days_until_expiry, issuer: data.issuer || 'Unknown' };
  } catch (e) {
    return { domain: domain, status: 'error', error: e.message };
  }
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  
  var event = {};
  try { event = await request.json(); } catch(e) {}
  
  if (event.type === 'checkout.session.completed') {
    var customerEmail = (event.data && event.data.object && event.data.object.customer_details && event.data.object.customer_details.email || '').toLowerCase();
    var subscriptionId = event.data && event.data.object && event.data.object.subscription;
    var customerId = event.data && event.data.object && event.data.object.customer;
    if (customerEmail) {
      var sub = await getSubscriber(env, customerEmail);
      if (sub) { sub.stripe_customer_id = customerId; sub.stripe_subscription_id = subscriptionId; sub.status = 'active'; sub.max_domains = 25; sub.updated_at = new Date().toISOString(); }
      else { sub = { email: customerEmail, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, status: 'active', max_domains: 25, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; }
      await putSubscriber(env, customerEmail, sub);
    }
  }
  
  if (event.type === 'customer.subscription.updated') {
    var sid = event.data && event.data.object && event.data.object.id;
    var st = event.data && event.data.object && event.data.object.status;
    var ce = (event.data && event.data.object && event.data.object.metadata && event.data.object.metadata.email || '').toLowerCase();
    if (ce) { var s = await getSubscriber(env, ce); if (s && s.stripe_subscription_id === sid) { s.status = st; s.updated_at = new Date().toISOString(); await putSubscriber(env, ce, s); } }
  }
  
  if (event.type === 'customer.subscription.deleted') {
    var sid2 = event.data && event.data.object && event.data.object.id;
    var ce2 = (event.data && event.data.object && event.data.object.metadata && event.data.object.metadata.email || '').toLowerCase();
    if (ce2) { var s2 = await getSubscriber(env, ce2); if (s2 && s2.stripe_subscription_id === sid2) { s2.status = 'cancelled'; s2.max_domains = 1; s2.updated_at = new Date().toISOString(); await putSubscriber(env, ce2, s2); } }
  }
  
  return json({ received: true });
}
