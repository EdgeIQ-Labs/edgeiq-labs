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
    const resp = await fetch(`https://edgeiqlabs.com/api/ssl-check?domain=${encodeURIComponent(domain)}`);
    const data = await resp.json();
    data._api = { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit };
    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
