/**
 * GET /api/cert-expiry?domain=example.com
 *
 * Checks SSL certificate expiry via crt.sh Certificate Transparency API.
 * Returns the most recently issued certificate's expiry date.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) {
    return json({ error: 'Valid domain required' }, 400);
  }

  try {
    // Try exact domain match first (faster, more precise)
    var resp = await fetch(
      'https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json',
      {
        headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0', 'Accept': 'application/json' },
      }
    );

    if (!resp.ok) {
      return json({ domain: domain, status: 'error', error: 'Certificate lookup failed' });
    }

    var text = await resp.text();
    var certs;
    try {
      certs = JSON.parse(text);
    } catch (parseErr) {
      return json({ domain: domain, status: 'error', error: 'Failed to parse certificate data' });
    }

    if (!Array.isArray(certs) || certs.length === 0) {
      return json({ domain: domain, status: 'error', error: 'No certificates found for this domain' });
    }

    // Filter to certs that cover this exact domain and have valid dates
    var matching = [];
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i];
      if (!c.not_after || !c.not_before) continue;
      // Check if this cert covers the requested domain
      var nameValue = c.name_value || '';
      var commonName = c.common_name || '';
      if (nameValue.indexOf(domain) !== -1 || commonName === domain) {
        matching.push(c);
      }
    }

    if (matching.length === 0) {
      // Fall back to all certs if no exact match
      matching = certs.filter(function(c) { return c.not_after && c.not_before; });
    }

    if (matching.length === 0) {
      return json({ domain: domain, status: 'error', error: 'No valid certificates found' });
    }

    // Sort by not_before descending to get the most recently issued cert
    matching.sort(function(a, b) {
      return new Date(b.not_before).getTime() - new Date(a.not_before).getTime();
    });

    var latest = matching[0];
    var expiryDate = new Date(latest.not_after);
    var now = new Date();
    var daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

    var status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    // Extract issuer CN
    var issuerRaw = latest.issuer_name || 'Unknown';
    var issuerCN = issuerRaw;
    var cnMatch = issuerRaw.match(/CN=([^,]+)/);
    if (cnMatch) issuerCN = cnMatch[1];

    return json({
      domain: domain,
      status: status,
      expiry_date: expiryDate.toISOString(),
      days_until_expiry: daysUntilExpiry,
      issuer: issuerCN,
      common_name: latest.common_name || domain,
      serial: latest.serial_number || null,
    });
  } catch (e) {
    return json({ domain: domain, status: 'error', error: e.message || 'Unknown error' });
  }
}
