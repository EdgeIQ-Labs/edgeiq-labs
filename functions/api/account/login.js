/**
 * POST /api/account/login
 * Body: { email }
 *
 * Generates a one-time magic link token, stores it in KV (1hr TTL),
 * and sends a sign-in email via Resend.
 *
 * KV binding: PULSE_KV
 * Env vars:   RESEND_API_KEY, SITE_URL, FROM_EMAIL
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function buildMagicLinkEmail(email, magicLink) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:32px 20px;">

  <div style="text-align:center;margin-bottom:28px;">
    <div style="display:inline-block;background:rgba(61,217,255,0.12);border:1px solid rgba(61,217,255,0.3);color:#3dd9ff;font-size:11px;font-weight:700;padding:4px 12px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      EdgeIQ Labs · Account Sign-In
    </div>
    <h1 style="color:#e8eef7;font-size:22px;font-weight:800;margin:0 0 8px;">Your sign-in link</h1>
    <p style="color:#9fb0c7;font-size:14px;margin:0;">Click the button below to sign in to your EdgeIQ account. This link expires in 1 hour and can only be used once.</p>
  </div>

  <div style="text-align:center;margin-bottom:28px;">
    <a href="${magicLink}" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;">
      Sign in to EdgeIQ →
    </a>
  </div>

  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
    <p style="color:#9fb0c7;font-size:12px;margin:0 0 6px;">Or copy this link into your browser:</p>
    <p style="color:#3dd9ff;font-size:11px;word-break:break-all;margin:0;">${magicLink}</p>
  </div>

  <div style="border-top:1px solid #1e2e3e;padding-top:18px;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 4px;">If you didn't request this link, you can safely ignore this email.</p>
    <p style="margin:0;">EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
  </div>
</div>
</body>
</html>`;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Valid email address required.' }, 400);
  }

  if (!env.PULSE_KV) return json({ error: 'Service unavailable.' }, 503);

  // Generate a 64-char hex token (32 random bytes)
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  // Store token in KV — 1 hour TTL
  await env.PULSE_KV.put(
    `acct:token:${token}`,
    JSON.stringify({ email, created_at: new Date().toISOString() }),
    { expirationTtl: 3600 }
  );

  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const magicLink = `${siteUrl}/api/account/verify?token=${token}`;

  // Send email via Resend
  if (env.RESEND_API_KEY) {
    const fromEmail = env.FROM_EMAIL || 'alerts@edgeiqlabs.com';
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: `EdgeIQ Labs <${fromEmail}>`,
          to: [email],
          subject: 'Your EdgeIQ sign-in link',
          html: buildMagicLinkEmail(email, magicLink),
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.error('Magic link email failed:', err.message);
      // Don't expose this error to the client — still return ok
    }
  } else {
    // Dev mode: log the link
    console.log(`[DEV] Magic link for ${email}: ${magicLink}`);
  }

  return json({ ok: true, message: 'Sign-in link sent — check your email.' });
}
