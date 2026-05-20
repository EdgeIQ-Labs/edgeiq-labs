/**
 * POST /api/compliance-signup
 * Body: { email, domain, plan: 'free'|'pro', stripe_session_id? }
 *
 * Free plan  : stored immediately, no Stripe required.
 * Pro plan   : requires a verified Stripe Checkout session_id.
 *
 * KV key   : compliance:{email}:{domain}
 * KV value : { email, domain, plan, active, created_at,
 *              last_scan_at, last_score, last_grade, last_controls, scan_count }
 *
 * KV binding : PULSE_KV
 * Env vars   : STRIPE_SECRET_KEY, RESEND_API_KEY
 */

async function sendWelcomeEmail(env, email, domain, plan, nextScanDate) {
  if (!env.RESEND_API_KEY || plan !== 'pro') return;
  const bg = '#0b0f14', card = '#121923', text = '#e8eef7', muted = '#9fb0c7', border = '#1e2e3e', green = '#3de19e';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${bg};font-family:Inter,system-ui,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="padding:0 0 24px;"><span style="font-size:18px;font-weight:800;color:${text};">EdgeIQ<span style="color:${green}"> Labs</span></span></td></tr>
    <tr><td style="background:${card};border:1px solid ${border};border-radius:14px;padding:32px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${green};margin-bottom:12px;">📋 Compliance Pro Active</div>
      <h1 style="font-size:22px;font-weight:800;color:${text};margin:0 0 12px;">Weekly compliance monitoring is on</h1>
      <p style="font-size:14px;color:${muted};line-height:1.7;margin:0 0 24px;">Your first automated SOC 2 scan for <strong style="color:${text};">${domain}</strong> runs on <strong style="color:${text};">${nextScanDate}</strong> at 08:00 UTC. After that, every Monday you'll receive a grade, score, and prioritised fix list by email.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        ${[
          ['Grade + score every Monday','A–F grade with percentage score so you always know where you stand'],
          ['Score diff alert','We flag when your score drops vs the previous week'],
          ['Prioritised fix list','Actionable items ranked by severity so you know what to fix first'],
          ['8 SOC 2 controls checked','HTTPS, HSTS, CSP, SPF, DMARC, server exposure, and more'],
        ].map(([t,b]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${border};">
          <div style="font-size:13px;font-weight:700;color:${text};margin-bottom:2px;">${t}</div>
          <div style="font-size:12px;color:${muted};">${b}</div>
        </td></tr>`).join('')}
      </table>
      <p style="font-size:13px;color:${muted};line-height:1.6;margin:0 0 20px;">Want to run a manual scan right now? Head to the compliance dashboard — results are instant.</p>
      <a href="https://edgeiqlabs.com/compliance/?domain=${encodeURIComponent(domain)}" style="display:inline-block;background:${green};color:#071018;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Run a manual scan now →</a>
    </td></tr>
    <tr><td style="padding:20px 0 0;text-align:center;font-size:11px;color:#4a6080;">
      © 2026 EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a>
    </td></tr>
  </table></td></tr></table>
  </body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'EdgeIQ Labs <security@edgeiqlabs.com>', to: [email], subject: `Compliance Pro active for ${domain} — first scan runs ${nextScanDate}`, html }),
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

  const email  = (body.email  || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const plan   = (body.plan   || 'free').trim().toLowerCase();
  const sid    = (body.stripe_session_id || '').trim();

  if (!isEmail(email))  return json({ error: 'Invalid email address.' }, 400);
  if (!isDomain(domain)) return json({ error: 'Invalid domain — use format: example.com' }, 400);
  if (!['free', 'pro'].includes(plan)) return json({ error: 'Invalid plan.' }, 400);

  if (plan === 'pro') {
    if (!sid) return json({ error: 'Stripe session required for Pro plan.' }, 402);
    const ok = await verifyStripe(env, sid, email);
    if (!ok) return json({ error: 'Could not verify Stripe payment. Contact support@edgeiqlabs.com.' }, 402);
  }

  const record = {
    email, domain, plan, active: true,
    created_at:    new Date().toISOString(),
    last_scan_at:  null,
    last_score:    null,
    last_grade:    null,
    last_controls: null,
    scan_count:    0,
    ...(sid && { stripe_session_id: sid }),
  };

  if (env.PULSE_KV) {
    await env.PULSE_KV.put(
      `compliance:${email}:${domain}`,
      JSON.stringify(record),
      { metadata: { email, domain, plan, created_at: record.created_at } }
    ).catch(e => console.error('KV write failed:', e.message));
  }

  const daysToMonday = (8 - new Date().getUTCDay()) % 7 || 7;
  const nextScan = new Date();
  nextScan.setUTCDate(nextScan.getUTCDate() + daysToMonday);
  nextScan.setUTCHours(8, 0, 0, 0);
  const nextScanDate = nextScan.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  await sendWelcomeEmail(env, email, domain, plan, nextScanDate);

  return json({ ok: true, domain, plan, next_scan: nextScan.toISOString().split('T')[0] });
}
