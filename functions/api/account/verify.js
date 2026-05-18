/**
 * GET /api/account/verify?token=XXX
 *
 * Validates a magic-link token, creates a 7-day session, sets an
 * HttpOnly session cookie, and redirects the browser to /account/.
 *
 * KV binding: PULSE_KV
 */

export async function onRequestGet({ request, env }) {
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  // Basic format check — tokens are 64 lowercase hex chars
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/account/?error=invalid_token` },
    });
  }

  if (!env.PULSE_KV) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/account/?error=service_unavailable` },
    });
  }

  // Look up token
  const raw = await env.PULSE_KV.get(`acct:token:${token}`);
  if (!raw) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/account/?error=expired` },
    });
  }

  let tokenData;
  try { tokenData = JSON.parse(raw); } catch {
    return new Response(null, {
      status: 302,
      headers: { Location: `${siteUrl}/account/?error=invalid_token` },
    });
  }

  // One-time use — delete token immediately
  await env.PULSE_KV.delete(`acct:token:${token}`).catch(() => {});

  const { email } = tokenData;

  // Create a 7-day session
  const sessionBytes = new Uint8Array(32);
  crypto.getRandomValues(sessionBytes);
  const sessionId = Array.from(sessionBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  await env.PULSE_KV.put(
    `acct:session:${sessionId}`,
    JSON.stringify({ email, created_at: new Date().toISOString() }),
    { expirationTtl: 604800 } // 7 days
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${siteUrl}/account/`,
      'Set-Cookie': `edgeiq_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    },
  });
}
