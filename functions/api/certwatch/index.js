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
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  return json({ service: 'CertWatch', version: '1.0', endpoints: ['/check', '/domains', '/webhook'] });
}
