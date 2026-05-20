/**
 * EdgeIQ — SSL & Security Headers Checker
 * GET /api/ssl-check?domain=example.com
 *
 * Checks HTTPS reachability, HTTP→HTTPS redirect, HSTS,
 * and key security response headers.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SECURITY_HEADERS = [
  { name: 'strict-transport-security', label: 'HSTS',                    critical: true  },
  { name: 'content-security-policy',   label: 'Content-Security-Policy', critical: true  },
  { name: 'x-frame-options',           label: 'X-Frame-Options',         critical: true  },
  { name: 'x-content-type-options',    label: 'X-Content-Type-Options',  critical: false },
  { name: 'referrer-policy',           label: 'Referrer-Policy',         critical: false },
  { name: 'permissions-policy',        label: 'Permissions-Policy',      critical: false },
];

const LEAK_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version'];

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch { return null; }
}

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!domain || !domain.includes('.') || domain.length < 4) {
    return Response.json({ error: 'Invalid domain' }, { status: 400, headers: CORS });
  }

  // Fetch both HTTP and HTTPS in parallel
  const [httpsResp, httpResp] = await Promise.all([
    fetchWithTimeout(`https://${domain}/`, { redirect: 'manual', method: 'HEAD' }),
    fetchWithTimeout(`http://${domain}/`,  { redirect: 'manual', method: 'HEAD' }),
  ]);

  const httpsOk     = !!httpsResp && httpsResp.status < 600;
  const httpsStatus = httpsResp ? httpsResp.status : null;

  // Check HTTP→HTTPS redirect
  let redirectsToHttps = false;
  if (httpResp) {
    const loc = httpResp.headers.get('location') || '';
    redirectsToHttps = (httpResp.status >= 301 && httpResp.status <= 308) && loc.startsWith('https://');
  }

  // Parse security headers from HTTPS response
  const headers      = {};
  const leaks        = {};
  const hstsHeader   = httpsResp ? httpsResp.headers.get('strict-transport-security') : null;

  if (httpsResp) {
    for (const h of SECURITY_HEADERS) {
      const val = httpsResp.headers.get(h.name);
      headers[h.name] = { present: !!val, value: val || null, label: h.label, critical: h.critical };
    }
    for (const h of LEAK_HEADERS) {
      const val = httpsResp.headers.get(h);
      if (val) leaks[h] = val;
    }
  }

  // Parse HSTS max-age
  let hstsMaxAge = null;
  if (hstsHeader) {
    const m = hstsHeader.match(/max-age=(\d+)/i);
    if (m) hstsMaxAge = parseInt(m[1], 10);
  }

  // Score: 0-100
  const checks = [
    httpsOk,
    redirectsToHttps,
    !!hstsHeader,
    hstsMaxAge && hstsMaxAge >= 31536000,
    headers['content-security-policy']?.present,
    headers['x-frame-options']?.present,
    headers['x-content-type-options']?.present,
    headers['referrer-policy']?.present,
    Object.keys(leaks).length === 0,
  ];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

  return Response.json({
    domain,
    https: {
      accessible:         httpsOk,
      status:             httpsStatus,
      redirects_to_https: redirectsToHttps,
    },
    hsts: {
      present:   !!hstsHeader,
      header:    hstsHeader,
      max_age:   hstsMaxAge,
      good:      hstsMaxAge && hstsMaxAge >= 31536000,
    },
    headers,
    leaks:  Object.keys(leaks).length ? leaks : null,
    score,
    grade,
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=120' } });
}
