/**
 * GET /api/email-suite/status — Check if user has active Email Security Suite subscription
 * Returns: { subscribed: boolean, plan: string|null, granted_at: string|null }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  const kv = env.EMAIL_SUITE_KV;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), { status: 500, headers });
  }

  // Extract email from query param, cookie, or Authorization header
  let email = null;

  // 1. Query param (for testing / simple integrations)
  const url = new URL(request.url);
  email = url.searchParams.get('email');

  // 2. Authorization header (Bearer token or basic)
  if (!email) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) {
      // For MVP, treat bearer value as email directly
      email = auth.slice(7).trim();
    }
  }

  // 3. Session cookie (future: full auth integration)
  if (!email) {
    const cookies = request.headers.get('Cookie') || '';
    const match = cookies.match(/(?:^|;)\s*email=([^;]+)/);
    if (match) email = decodeURIComponent(match[1]);
  }

  if (!email) {
    return new Response(JSON.stringify({ subscribed: false, plan: null, granted_at: null }), {
      status: 200,
      headers,
    });
  }

  // Normalize email
  email = email.toLowerCase().trim();

  try {
    const subData = await kv.get(`sub:${email}`, 'json');
    if (subData && subData.status === 'active') {
      return new Response(JSON.stringify({
        subscribed: true,
        plan: subData.plan || 'bundle',
        granted_at: subData.granted_at || null,
      }), { status: 200, headers });
    }

    // Fallback: check suite_index
    const index = (await kv.get('suite_index', 'json')) || [];
    if (index.includes(email)) {
      return new Response(JSON.stringify({
        subscribed: true,
        plan: 'bundle',
        granted_at: null,
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ subscribed: false, plan: null, granted_at: null }), {
      status: 200,
      headers,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
