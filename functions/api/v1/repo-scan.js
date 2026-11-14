/**
 * EdgeIQ API v1 — Repo Security Scanner
 * POST /api/v1/repo-scan
 * Body: { "url": "https://github.com/org/repo" }
 * Auth: Bearer <api_key> or X-API-Key header
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key' } });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST with JSON body: { "url": "..." }' }), { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  // Auth check
  const { validateApiKey, apiResponse } = await import('../_apimarket.js');
  const auth = await validateApiKey(request, env);
  if (!auth.valid) {
    return apiResponse({ error: auth.error }, auth.status, auth.headers || {});
  }

  try {
    const body = await request.json();
    if (!body.url) return apiResponse({ error: 'Missing "url" field' }, 400);

    // Delegate to existing scanner by re-calling it internally
    const scannerUrl = new URL(request.url);
    scannerUrl.pathname = '/api/repo-scanner';
    const internalReq = new Request(scannerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // We can't call other Pages Functions directly, so we replicate the core fetch
    // Instead, use the public endpoint
    const resp = await fetch('https://edgeiqlabs.com/api/repo-scanner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();

    // Add API metadata
    data._api = {
      tier: auth.tier,
      remaining_requests: auth.keyData.remaining,
      rate_limit: auth.keyData.limit
    };

    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
