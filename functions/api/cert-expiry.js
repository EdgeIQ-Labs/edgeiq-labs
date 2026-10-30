/**
 * GET /api/cert-expiry?domain=example.com
 *
 * Checks SSL certificate expiry via crt.sh Certificate Transparency API.
 * Returns the most recently issued certificate's expiry date.
 *
 * Returns: { domain, expiry_date, days_until_expiry, issuer, status }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return resp;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
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
    // Query crt.sh for certificates issued to this domain
    let resp;
    try {
      resp = await fetchWithTimeout(
        `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`,
        10000
      );
    } catch (fetchErr) {
      // Retry with exact domain match if wildcard fails
      resp = await fetchWithTimeout(
        `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
        10000
      );
    }

    if (!resp.ok) {
      return json({ domain, status: 'error', error: `crt.sh returned ${resp.status}` });
    }

    const text = await resp.text();
    let certs;
    try {
      certs = JSON.parse(text);
    } catch (parseErr) {
      return json({ domain, status: 'error', error: 'Failed to parse crt.sh response' });
    }

    if (!Array.isArray(certs) || certs.length === 0) {
      // Try exact match without wildcard as fallback
      if (!text.includes('"not_after"')) {
        const resp2 = await fetchWithTimeout(
          `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
          10000
        );
        if (resp2.ok) {
          const text2 = await resp2.text();
          try {
            certs = JSON.parse(text2);
          } catch {}
        }
      }

      if (!Array.isArray(certs) || certs.length === 0) {
        return json({ domain, status: 'error', error: 'No certificates found for this domain' });
      }
    }

    return processCerts(domain, certs);
  } catch (e) {
    return json({ domain, status: 'error', error: e.message || 'Unknown error' });
  }
}

function processCerts(domain, certs) {
  // Find the most recently issued certificate
  // Sort by not_before descending to get the latest cert
  const sorted = certs
    .filter(function(c) { return c.not_after && c.not_before; })
    .sort(function(a, b) { return new Date(b.not_before).getTime() - new Date(a.not_before).getTime(); });

  if (sorted.length === 0) {
    return { domain: domain, status: 'error', error: 'No valid certificates found' };
  }

  const latest = sorted[0];
  const expiryDate = new Date(latest.not_after);
  const now = new Date();
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  var status = 'valid';
  if (daysUntilExpiry <= 0) status = 'expired';
  else if (daysUntilExpiry <= 30) status = 'expiring_soon';

  // Extract issuer CN from issuer_name field
  const issuer = latest.issuer_name || 'Unknown';
  const cnMatch = issuer.match(/CN=([^,]+)/);
  const issuerCN = cnMatch ? cnMatch[1] : issuer;

  return {
    domain: domain,
    status: status,
    expiry_date: expiryDate.toISOString(),
    days_until_expiry: daysUntilExpiry,
    issuer: issuerCN,
    common_name: latest.common_name || domain,
    serial: latest.serial_number || null,
  };
}
