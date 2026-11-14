/**
 * EdgeIQ Labs — Rate Watch: Unsubscribe endpoint
 * POST /api/rate-watch/unsubscribe
 * Accepts {email} or ?token= query param, marks subscriber inactive
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let email = null;

  // Support GET with ?token= for email link unsubscribes
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (token) {
      // Token is base64-encoded email for simplicity in MVP
      try {
        email = atob(token).toLowerCase();
      } catch {
        return new Response('Invalid unsubscribe token', { status: 400 });
      }
    }
  }

  // Support POST with {email}
  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    email = (body.email || '').trim().toLowerCase();
  }

  if (!email) {
    return new Response(JSON.stringify({ success: false, error: 'Email or token required' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const existing = await env.RATE_WATCH_KV.get(`sub:${email}`, 'json');
  if (!existing) {
    return new Response(JSON.stringify({ success: true, message: 'Not found' }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  existing.status = 'inactive';
  existing.unsubscribed_at = new Date().toISOString();
  await env.RATE_WATCH_KV.put(`sub:${email}`, JSON.stringify(existing));

  // For GET requests (email links), return HTML confirmation
  if (request.method === 'GET') {
    return new Response(`<!DOCTYPE html><html><head><title>Unsubscribed</title><style>body{font-family:system-ui;background:#0b0f14;color:#e8eef7;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center;}h1{color:#3de19e;}</style></head><body><div><h1>✓ Unsubscribed</h1><p>You will no longer receive rate change alerts.</p><a href="/rate-watch/" style="color:#3dd9ff;">Back to Rate Watch</a></div></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
