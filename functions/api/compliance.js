/**
 * GET /api/compliance?domain=...&framework=...
 * Proxies to compliance.edgeiqlabs.com with CORS headers so the
 * compliance posture tracker at /compliance/ can call it cross-origin.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const domain = url.searchParams.get('domain') || '';
  const framework = url.searchParams.get('framework') || 'soc2';

  if (!domain) {
    return new Response(JSON.stringify({ error: 'domain required' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const upstream = `https://compliance.edgeiqlabs.com/api/compliance?domain=${encodeURIComponent(domain)}&framework=${encodeURIComponent(framework)}`;
    const resp = await fetch(upstream, { signal: AbortSignal.timeout(25000) });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Compliance API unavailable', detail: err.message }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
