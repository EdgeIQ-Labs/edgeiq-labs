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
  
  var authEmail = (request.headers.get('X-CertWatch-Email') || '').trim().toLowerCase();
  if (!authEmail || !authEmail.includes('@')) return json({ error: 'Authentication required. Pass X-CertWatch-Email header.' }, 401);
  
  var subscriber = await getSubscriber(env, authEmail);
  if (!subscriber) {
    subscriber = { email: authEmail, stripe_customer_id: null, stripe_subscription_id: null, status: 'free', max_domains: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await putSubscriber(env, authEmail, subscriber);
  }
  
  if (request.method === 'GET') {
    var domains = await getDomains(env, authEmail);
    return json({ domains: domains, max_domains: subscriber.max_domains, count: domains.length, status: subscriber.status });
  }
  
  if (request.method === 'POST') {
    var body = {};
    try { body = await request.json(); } catch(e) {}
    var domain = (body.domain || '').trim().toLowerCase();
    if (!domain || !domain.includes('.')) return json({ error: 'Valid domain required' }, 400);
    
    var domains = await getDomains(env, authEmail);
    if (domains.length >= subscriber.max_domains) return json({ error: 'Domain limit reached (' + subscriber.max_domains + '). Upgrade to add more.', upgrade_url: 'https://buy.stripe.com/cNi9AV8dZ7hb3jS2cg7wB2v' }, 403);
    if (domains.some(function(d) { return d.domain === domain; })) return json({ error: 'Domain already monitored' }, 409);
    
    var checkResult = await checkCertViaWorker(domain);
    var newDomain = { domain: domain, added_at: new Date().toISOString(), last_checked_at: checkResult.status !== 'error' ? new Date().toISOString() : null, last_expiry_date: checkResult.expiry_date || null, last_issuer: checkResult.issuer || null, last_status: checkResult.status || 'error', last_days_until_expiry: checkResult.days_until_expiry || null };
    domains.push(newDomain);
    await putDomains(env, authEmail, domains);
    return json({ success: true, domain: newDomain, check: checkResult }, 201);
  }
  
  return json({ error: 'Method not allowed' }, 405);
}
