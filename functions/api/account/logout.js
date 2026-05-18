/**
 * POST /api/account/logout
 *
 * Deletes the KV session record and clears the session cookie.
 * Redirects to /account/ after logout.
 *
 * KV binding: PULSE_KV
 */

export async function onRequestPost({ request, env }) {
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';

  // Delete session from KV
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/edgeiq_session=([a-f0-9]{64})/);
  if (match && env.PULSE_KV) {
    await env.PULSE_KV.delete(`acct:session:${match[1]}`).catch(() => {});
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${siteUrl}/account/`,
      'Set-Cookie': 'edgeiq_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    },
  });
}
