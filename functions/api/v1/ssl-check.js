/**
 * EdgeIQ API v1 — SSL Certificate Checker
 * GET /api/v1/ssl-check?domain=example.com
 * Auth: Bearer <api_key> or X-API-Key header
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key' } });
  }

  const { validateApiKey, apiResponse } = await import('../_apimarket.js');
  const auth = await validateApiKey(request, env);
  if (!auth.valid) {
    return apiResponse({ error: auth.error }, auth.status, auth.headers || {});
  }

  const url = new URL(request.url);
  const domain = url.searchParams.get('domain');
  if (!domain) return apiResponse({ error: 'Missing ?domain= parameter' }, 400);

  try {
    // Direct SSL check via crt.sh — no self-fetch loop
    const crtResp = await fetch('https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json', { headers: { 'Accept': 'application/json' } });
    if (!crtResp.ok) return apiResponse({ domain, status: 'error', error: 'Certificate lookup failed' });
    const certs = await crtResp.json();
    if (!Array.isArray(certs) || certs.length === 0) return apiResponse({ domain, status: 'error', error: 'No certificates found' });
    const valid = certs.filter(c => c.not_after && c.not_before).sort((a,b) => new Date(b.not_before) - new Date(a.not_before));
    const latest = valid[0];
    const expiry = new Date(latest.not_after);
    const days = Math.ceil((expiry - new Date()) / 86400000);
    const data = { domain, status: days <= 0 ? 'expired' : days <= 30 ? 'expiring_soon' : 'valid', expiry_date: expiry.toISOString(), days_until_expiry: days, issuer: (latest.issuer_name||'').match(/CN=([^,]+)/)?.[1] || 'Unknown', _api: { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit } };
    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
