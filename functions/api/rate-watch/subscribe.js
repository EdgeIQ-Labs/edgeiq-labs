/**
 * EdgeIQ Labs — Rate Watch: Subscribe endpoint
 * POST /api/rate-watch/subscribe
 * Accepts {email}, validates, stores in RATE_WATCH_KV
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    return new Response(JSON.stringify({ success: false, error: 'Valid email required' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Check if already subscribed
  const existing = await env.RATE_WATCH_KV.get(`sub:${email}`, 'json');
  if (existing && existing.status === 'active') {
    return new Response(JSON.stringify({ success: true, message: 'Already subscribed' }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Extract affiliate ref from query string or body
  const url = new URL(request.url);
  const ref = (body.ref || url.searchParams.get('ref') || '').trim().toLowerCase();

  // Store subscriber
  const subscriber = {
    email,
    subscribed_at: new Date().toISOString(),
    status: 'active',
    ref: ref || null,
  };

  await env.RATE_WATCH_KV.put(`sub:${email}`, JSON.stringify(subscriber));

  // Add to subscribers list index for batch retrieval
  let index = await env.RATE_WATCH_KV.get('subscribers_index', 'json') || [];
  if (!index.includes(email)) {
    index.push(email);
    await env.RATE_WATCH_KV.put('subscribers_index', JSON.stringify(index));
  }

  // Track affiliate referral counts
  if (ref) {
    const refKey = `ref:${ref}`;
    const refData = await env.RATE_WATCH_KV.get(refKey, 'json') || { count: 0, emails: [] };
    refData.count++;
    if (!refData.emails.includes(email)) refData.emails.push(email);
    refData.last_signup = new Date().toISOString();
    await env.RATE_WATCH_KV.put(refKey, JSON.stringify(refData));
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
