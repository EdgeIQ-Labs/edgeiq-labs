/**
 * EdgeIQ API v1 — HTTP Header Analyzer
 * GET /api/v1/header-check?domain=example.com
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
    // Direct header check — no self-fetch loop
    const resp = await fetch(`https://${domain}`, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'EdgeIQ-HeaderCheck/1.0' } });
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    const securityHeaders = ['strict-transport-security','content-security-policy','x-frame-options','x-content-type-options','referrer-policy','permissions-policy','cross-origin-opener-policy','cross-origin-resource-policy'];
    const found = {}, missing = [];
    securityHeaders.forEach(h => { if (headers[h]) found[h] = headers[h]; else missing.push(h); });
    const grade = missing.length === 0 ? 'A' : missing.length <= 2 ? 'B' : missing.length <= 4 ? 'C' : 'D';
    const data = { domain, grade, found, missing, status_code: resp.status, _api: { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit } };
    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
