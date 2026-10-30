/**
 * GET /api/cert-expiry?domain=example.com
 *
 * Checks SSL certificate expiry via CertSpotter API.
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
    // CertSpotter API — no auth needed for basic queries, fast response
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let resp;
    try {
      resp = await fetch(
        `https://api.certspotter.com/v1/certs?domain=${encodeURIComponent(domain)}&expand=dns_names`,
        {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      // Fallback: try without expand param
      resp = await fetch(
        `https://api.certspotter.com/v1/certs?domain=${encodeURIComponent(domain)}`,
        { headers: { 'Accept': 'application/json' } }
      );
    }

    if (!resp.ok) {
      // If CertSpotter fails, try crt.sh as last resort with shorter timeout
      return await tryCrtShFallback(domain);
    }

    const certs = await resp.json();

    if (!Array.isArray(certs) || certs.length === 0) {
      return await tryCrtShFallback(domain);
    }

    return processCerts(domain, certs);
  } catch (e) {
    return json({ domain, status: 'error', error: e.message || 'Unknown error' });
  }
}

async function tryCrtShFallback(domain) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (!resp.ok) {
      return json({ domain, status: 'error', error: 'No certificates found' });
    }

    const text = await resp.text();
    const certs = JSON.parse(text);

    if (!Array.isArray(certs) || certs.length === 0) {
      return json({ domain, status: 'error', error: 'No certificates found for this domain' });
    }

    // crt.sh uses not_before/not_after format
    const sorted = certs
      .filter(function(c) { return c.not_after && c.not_before; })
      .sort(function(a, b) { return new Date(b.not_before).getTime() - new Date(a.not_before).getTime(); });

    if (sorted.length === 0) {
      return json({ domain, status: 'error', error: 'No valid certificates found' });
    }

    const latest = sorted[0];
    return buildResult(domain, latest.not_after, latest.issuer_name, latest.common_name, latest.serial_number);
  } catch (e) {
    return json({ domain, status: 'error', error: 'Certificate lookup failed' });
  }
}

function processCerts(domain, certs) {
  // CertSpotter returns certs sorted by issuance date descending
  // Each cert has: dns_names[], not_before, not_after, issuer
  const valid = certs.filter(function(c) {
    return c.not_after && c.not_before;
  });

  if (valid.length === 0) {
    return { domain: domain, status: 'error', error: 'No valid certificates found' };
  }

  const latest = valid[0];
  const issuerName = latest.issuer ? latest.issuer.name || latest.issuer : 'Unknown';
  const commonName = latest.dns_names ? latest.dns_names[0] : domain;

  return buildResult(domain, latest.not_after, issuerName, commonName, latest.serial || null);
}

function buildResult(domain, notAfter, issuerRaw, commonName, serial) {
  const expiryDate = new Date(notAfter);
  const now = new Date();
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  var status = 'valid';
  if (daysUntilExpiry <= 0) status = 'expired';
  else if (daysUntilExpiry <= 30) status = 'expiring_soon';

  // Extract CN from issuer string if it's in DN format
  var issuerCN = issuerRaw;
  if (typeof issuerRaw === 'string') {
    const cnMatch = issuerRaw.match(/CN=([^,]+)/);
    if (cnMatch) issuerCN = cnMatch[1];
  } else if (issuerRaw && typeof issuerRaw === 'object' && issuerRaw.name) {
    issuerCN = issuerRaw.name;
  }

  return {
    domain: domain,
    status: status,
    expiry_date: expiryDate.toISOString(),
    days_until_expiry: daysUntilExpiry,
    issuer: issuerCN,
    common_name: commonName || domain,
    serial: serial || null,
  };
}
