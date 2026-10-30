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

// Inline cert expiry check via crt.sh — no self-referential HTTP call needed
async function checkCertExpiry(domain) {
  try {
    var resp = await fetch('https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json', {
      headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0', 'Accept': 'application/json' },
    });
    if (!resp.ok) return { domain: domain, status: 'error', error: 'Certificate lookup failed' };
    var text = await resp.text();
    var certs;
    try { certs = JSON.parse(text); } catch(e) { return { domain: domain, status: 'error', error: 'Failed to parse certificate data' }; }
    if (!Array.isArray(certs) || certs.length === 0) return { domain: domain, status: 'error', error: 'No certificates found' };
    
    // Filter to matching certs with valid dates
    var matching = [];
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i];
      if (!c.not_after || !c.not_before) continue;
      var nv = c.name_value || '';
      var cn = c.common_name || '';
      if (nv.indexOf(domain) !== -1 || cn === domain) matching.push(c);
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
    return { domain: domain, status: status, expiry_date: expiryDate.toISOString(), days_until_expiry: daysUntilExpiry, issuer: issuerCN, common_name: latest.common_name || domain, serial: latest.serial_number || null };
  } catch (e) {
    return { domain: domain, status: 'error', error: e.message || 'Unknown error' };
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  var body = {};
  try { body = await context.request.json(); } catch(e) {}
  var domain = (body.domain || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) return json({ error: 'Valid domain required' }, 400);
  var result = await checkCertExpiry(domain);
  return json(result);
}
