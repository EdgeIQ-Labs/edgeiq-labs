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

// INLINED cert check — no self-fetch loop
async function checkCertViaWorker(domain) {
  try {
    var resp = await fetch(
      'https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json',
      { headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0', 'Accept': 'application/json' } }
    );
    if (!resp.ok) return { domain: domain, status: 'error', error: 'Certificate lookup failed' };
    var text = await resp.text();
    var certs;
    try { certs = JSON.parse(text); } catch { return { domain: domain, status: 'error', error: 'Failed to parse certificate data' }; }
    if (!Array.isArray(certs) || certs.length === 0) return { domain: domain, status: 'error', error: 'No certificates found' };
    var matching = [];
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i];
      if (!c.not_after || !c.not_before) continue;
      var nameValue = c.name_value || '';
      var commonName = c.common_name || '';
      if (nameValue.indexOf(domain) !== -1 || commonName === domain) matching.push(c);
    }
    if (matching.length === 0) matching = certs.filter(function(c) { return c.not_after && c.not_before; });
    if (matching.length === 0) return { domain: domain, status: 'error', error: 'No valid certificates found' };
    matching.sort(function(a, b) { return new Date(b.not_before).getTime() - new Date(a.not_before).getTime(); });
    var latest = matching[0];
    var expiryDate = new Date(latest.not_after);
    var now = new Date();
    var daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    var status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';
    var issuerRaw = latest.issuer_name || 'Unknown';
    var cnMatch = issuerRaw.match(/CN=([^,]+)/);
    var issuerCN = cnMatch ? cnMatch[1] : issuerRaw;
    return { domain: domain, status: status, expiry_date: expiryDate.toISOString(), days_until_expiry: daysUntilExpiry, issuer: issuerCN };
  } catch (e) {
    return { domain: domain, status: 'error', error: e.message };
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  return json({ service: 'CertWatch', version: '1.0', endpoints: ['/check', '/domains', '/webhook'] });
}
