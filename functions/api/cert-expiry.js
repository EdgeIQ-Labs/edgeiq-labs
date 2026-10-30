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
    const resp = await fetch(
      `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`,
      {
        headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0' },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) {
      return json({ domain, status: 'error', error: `crt.sh returned ${resp.status}` });
    }

    const certs = await resp.json();

    if (!Array.isArray(certs) || certs.length === 0) {
      // Try exact match without wildcard
      const resp2 = await fetch(
        `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`,
        {
          headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0' },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!resp2.ok) {
        return json({ domain, status: 'error', error: 'No certificates found' });
      }

      const certs2 = await resp2.json();
      if (!Array.isArray(certs2) || certs2.length === 0) {
        return json({ domain, status: 'error', error: 'No certificates found for this domain' });
      }

      // Use the second query results
      return processCerts(domain, certs2);
    }

    return processCerts(domain, certs);
  } catch (e) {
    return json({ domain, status: 'error', error: e.message });
  }
}

function processCerts(domain, certs) {
  // Find the most recently issued certificate that covers this domain
  // Sort by not_before descending to get the latest cert
  const sorted = certs
    .filter(c => c.not_after && c.not_before)
    .sort((a, b) => new Date(b.not_before).getTime() - new Date(a.not_before).getTime());

  if (sorted.length === 0) {
    return { domain, status: 'error', error: 'No valid certificates found' };
  }

  const latest = sorted[0];
  const expiryDate = new Date(latest.not_after);
  const now = new Date();
  const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

  let status = 'valid';
  if (daysUntilExpiry <= 0) status = 'expired';
  else if (daysUntilExpiry <= 30) status = 'expiring_soon';

  // Extract issuer from issuer_name field
  const issuer = latest.issuer_name || 'Unknown';
  // Clean up issuer string — take just the CN part if present
  const issuerCN = issuer.match(/CN=([^,]+)/)?.[1] || issuer;

  return {
    domain,
    status,
    expiry_date: expiryDate.toISOString(),
    days_until_expiry: daysUntilExpiry,
    issuer: issuerCN,
    common_name: latest.common_name || domain,
    serial: latest.serial_number || null,
  };
}
