/**
 * EdgeIQ API v1 — Breach Exposure Checker
 * GET /api/v1/breach-check?email=user@example.com
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
  const email = url.searchParams.get('email');
  if (!email) return apiResponse({ error: 'Missing ?email= parameter' }, 400);

  try {
    // Direct breach check via Have I Been Pwned — no self-fetch loop
    const hibpKey = env.HIBP_API_KEY || '';
    const resp = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`, {
      headers: { 'hibp-api-key': hibpKey, 'User-Agent': 'EdgeIQ-BreachCheck/1.0' }
    });
    if (resp.status === 404) return apiResponse({ email, breached: false, breaches: [], _api: { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit } });
    if (!resp.ok) return apiResponse({ error: 'Breach check failed: ' + resp.status }, 500);
    const breaches = await resp.json();
    const data = { email, breached: true, breach_count: breaches.length, breaches: breaches.map(b => ({ name: b.Name, domain: b.Domain, date: b.BreachDate, records: b.PwnCount })), _api: { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit } };
    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
