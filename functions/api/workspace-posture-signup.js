/**
 * POST /api/workspace-posture-signup
 * Body: { email, domain, platform: 'm365'|'google', stripe_session_id }
 *
 * Workspace Posture Pro is paid-only ($19/mo early access).
 * Requires a verified Stripe Checkout session_id.
 *
 * KV key   : wp:{email}:{domain}
 * KV value : { email, domain, platform, active, created_at,
 *              last_scan_at, last_report_at, scan_count, stripe_session_id }
 *
 * KV binding : PULSE_KV
 * Env vars   : STRIPE_SECRET_KEY, RESEND_API_KEY
 */

async function sendWelcomeEmail(env, email, domain, platform) {
  if (!env.RESEND_API_KEY) return;
  const bg = '#0b0f14', card = '#121923', text = '#e8eef7', muted = '#9fb0c7', border = '#1e2e3e', blue = '#4da6ff';
  const platformLabel = platform === 'google' ? 'Google Workspace' : 'Microsoft 365';
  const platformChecks = platform === 'google'
    ? [['2-Step Verification enforcement','Checks all users have 2SV required, not just optional'],['Third-party app access','OAuth apps with excessive permissions or inactive app grants'],['External Drive sharing','Files shared publicly or with anyone who has the link'],['Stale super admins','Admin accounts with no recent login or offboarded users'],['Less secure app access','Legacy auth methods that bypass MFA']]
    : [['MFA enforcement','Accounts with MFA disabled including service accounts'],['Legacy authentication','SMTP AUTH, basic auth protocols that bypass Conditional Access'],['Stale admin accounts','Global admins with no recent sign-in'],['Email forwarding rules','Auto-forwards draining your inbox to external addresses'],['OAuth app consent','Third-party apps with broad API permissions']];
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${bg};font-family:Inter,system-ui,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="padding:0 0 24px;"><span style="font-size:18px;font-weight:800;color:${text};">EdgeIQ<span style="color:${blue}"> Labs</span></span></td></tr>
    <tr><td style="background:${card};border:1px solid ${border};border-radius:14px;padding:32px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${blue};margin-bottom:12px;">🏢 Workspace Posture Pro Active</div>
      <h1 style="font-size:22px;font-weight:800;color:${text};margin:0 0 12px;">Your ${platformLabel} audit is queued</h1>
      <p style="font-size:14px;color:${muted};line-height:1.7;margin:0 0 24px;">Workspace Posture Pro is now active for <strong style="color:${text};">${domain}</strong>. Your first ${platformLabel} security audit runs this Monday — you'll receive a prioritised fix list by email.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        ${platformChecks.map(([t,b]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${border};">
          <div style="font-size:13px;font-weight:700;color:${text};margin-bottom:2px;">${t}</div>
          <div style="font-size:12px;color:${muted};">${b}</div>
        </td></tr>`).join('')}
      </table>
      <p style="font-size:13px;color:${muted};line-height:1.6;margin:0 0 20px;">Early access rate of $19/mo is locked in for your account for as long as you stay subscribed — standard pricing will be $39/mo.</p>
      <a href="https://edgeiqlabs.com/account/" style="display:inline-block;background:${blue};color:#071018;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">View your account →</a>
    </td></tr>
    <tr><td style="padding:20px 0 0;text-align:center;font-size:11px;color:#4a6080;">
      © 2026 EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a>
    </td></tr>
  </table></td></tr></table>
  </body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'EdgeIQ Labs <security@edgeiqlabs.com>', to: [email], subject: `Workspace Posture Pro active — your first ${platformLabel} audit runs Monday`, html }),
  }).catch(() => {});
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function isDomain(d) { return /^[a-z0-9][a-z0-9\-\.]{1,61}[a-z0-9]\.[a-z]{2,}$/.test(d); }

async function verifyStripe(env, sessionId, email) {
  if (!env.STRIPE_SECRET_KEY || !sessionId) return false;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return false;
    const s = await r.json();
    if (s.payment_status !== 'paid' && s.status !== 'complete') return false;
    const sEmail = (s.customer_details?.email || s.customer_email || '').toLowerCase().trim();
    if (sEmail && sEmail !== email) return false;
    return true;
  } catch { return false; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email    = (body.email    || '').trim().toLowerCase();
  const domain   = (body.domain   || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const platform = (body.platform || 'm365').trim().toLowerCase();
  const sid      = (body.stripe_session_id || '').trim();

  if (!isEmail(email))   return json({ error: 'Invalid email address.' }, 400);
  if (!isDomain(domain)) return json({ error: 'Invalid domain — use format: example.com' }, 400);
  if (!['m365', 'google'].includes(platform)) return json({ error: 'Invalid platform. Use m365 or google.' }, 400);
  if (!sid)              return json({ error: 'Stripe session required.' }, 402);

  const ok = await verifyStripe(env, sid, email);
  if (!ok) return json({ error: 'Could not verify payment. Contact support@edgeiqlabs.com.' }, 402);

  const record = {
    email, domain, platform, plan: 'pro_early_access', active: true,
    created_at:       new Date().toISOString(),
    last_scan_at:     null,
    last_report_at:   null,
    scan_count:       0,
    stripe_session_id: sid,
  };

  if (env.PULSE_KV) {
    await env.PULSE_KV.put(
      `wp:${email}:${domain}`,
      JSON.stringify(record),
      { metadata: { email, domain, platform, created_at: record.created_at } }
    ).catch(e => console.error('KV write failed:', e.message));
  }

  await sendWelcomeEmail(env, email, domain, platform);

  return json({ ok: true, domain, platform, message: `Workspace Posture monitoring queued for ${domain}. Expect your connect link within 24 hours.` });
}
