/**
 * POST /api/smb-onboard
 * Body: { stripe_session_id }
 *
 * Called by welcome/smb/index.html immediately after Stripe checkout redirects
 * back to the site. Verifies the Stripe session, records the subscriber in KV,
 * and sends a personalised onboarding email via Resend.
 *
 * Env vars:  STRIPE_SECRET_KEY, RESEND_API_KEY
 * KV:        PULSE_KV
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

// ── Stripe helper ─────────────────────────────────────────────────────────────
async function stripeGet(env, path) {
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendWelcomeEmail(env, email, plan) {
  if (!env.RESEND_API_KEY || !email) return;

  const planLabel  = plan === 'smb-plus' ? 'SMB Plus' : 'SMB Essentials';
  const planColor  = plan === 'smb-plus' ? '#70f0a8' : '#3dd9ff';
  const bg         = '#0b0f14';
  const card       = '#121923';
  const text       = '#e8eef7';
  const muted      = '#9fb0c7';
  const border     = '#1e2e3e';

  function step(n, title, body) {
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid ${border};">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="width:28px;height:28px;background:rgba(61,217,255,0.12);color:${planColor};font-size:11px;font-weight:700;text-align:center;vertical-align:middle;border-radius:50%;border:1px solid rgba(61,217,255,0.25);">${n}</td>
            <td style="padding-left:12px;">
              <div style="font-size:13px;font-weight:700;color:${text};margin-bottom:3px;">${title}</div>
              <div style="font-size:12px;color:${muted};line-height:1.55;">${body}</div>
            </td>
          </tr></table>
        </td>
      </tr>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${bg};font-family:Inter,system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${bg};padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:${card};border:1px solid ${border};border-radius:16px;padding:40px 36px;" cellpadding="0" cellspacing="0">
        <tr><td style="text-align:center;padding-bottom:28px;">
          <div style="font-size:22px;font-weight:900;color:${text};">EdgeIQ <span style="color:${planColor};">Labs</span></div>
          <div style="margin-top:14px;display:inline-block;background:rgba(61,217,255,0.1);border:1px solid rgba(61,217,255,0.25);color:${planColor};font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:.06em;text-transform:uppercase;">● ${planLabel} Active</div>
          <h1 style="font-size:22px;font-weight:800;color:${text};margin:18px 0 8px;line-height:1.3;">Your business is now protected</h1>
          <p style="font-size:14px;color:${muted};line-height:1.6;margin:0;">We've activated <strong style="color:${text};">${planLabel}</strong> — weekly security monitoring starts immediately.</p>
        </td></tr>

        <tr><td style="padding-bottom:28px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${planColor};margin-bottom:10px;">What happens next</div>
          <table width="100%" cellpadding="0" cellspacing="0">
            ${step(1, 'First scan runs this Monday 08:00 UTC', 'We\'ll run a full baseline scan of your registered domain and send you the first digest immediately.')}
            ${step(2, 'Register your domain for monitoring', `Go to <a href="https://edgeiqlabs.com/pulse/" style="color:${planColor};">edgeiqlabs.com/pulse/</a> and enter your domain + this email to start weekly scans.`)}
            ${step(3, 'Set up email shield monitoring', `Activate SPF/DMARC/DKIM monitoring at <a href="https://edgeiqlabs.com/inbox-shield/" style="color:${planColor};">edgeiqlabs.com/inbox-shield/</a> — free with your plan.`)}
            ${step(4, 'Connect vendor alerts (optional)', `Watch when Stripe, GitHub, Cloudflare, and 11 other vendors go down at <a href="https://edgeiqlabs.com/vendor-watch/" style="color:${planColor};">edgeiqlabs.com/vendor-watch/</a>.`)}
          </table>
        </td></tr>

        <tr><td style="padding-bottom:28px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(61,217,255,0.04);border:1px solid rgba(61,217,255,0.15);border-radius:10px;padding:18px 20px;">
            <tr><td>
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${planColor};margin-bottom:10px;">What's included</div>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:50%;font-size:12px;color:${muted};padding:4px 0;">✓ Weekly automated security scans</td>
                  <td style="font-size:12px;color:${muted};padding:4px 0;">✓ SSL certificate monitoring</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:${muted};padding:4px 0;">✓ Email authentication checks (SPF/DKIM/DMARC)</td>
                  <td style="font-size:12px;color:${muted};padding:4px 0;">✓ Security headers grade</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:${muted};padding:4px 0;">✓ Vendor status monitoring</td>
                  <td style="font-size:12px;color:${muted};padding:4px 0;">✓ CVE & vulnerability matching</td>
                </tr>
                ${plan === 'smb-plus' ? `<tr><td colspan="2" style="font-size:12px;color:${text};padding:8px 0 0;font-weight:600;">Plus: Priority remediation support + expanded monthly action plan</td></tr>` : ''}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="text-align:center;padding-bottom:24px;">
          <a href="https://edgeiqlabs.com/pulse/" style="display:inline-block;background:${planColor};color:#071018;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;text-decoration:none;">Start Monitoring My Domain →</a>
        </td></tr>

        <tr><td style="text-align:center;border-top:1px solid ${border};padding-top:20px;">
          <p style="font-size:11px;color:#4a6080;line-height:1.6;margin:0;">
            Questions? Reply to this email or contact <a href="mailto:support@edgeiqlabs.com" style="color:${planColor};">support@edgeiqlabs.com</a><br>
            <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'EdgeIQ Labs <security@edgeiqlabs.com>',
      to: [email],
      subject: `Your ${planLabel} subscription is active — here's how to get started`,
      html,
    }),
  }).catch(() => {});
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Stripe not configured' }, 500);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const sessionId = (body.stripe_session_id || '').trim();
  if (!sessionId) return json({ error: 'stripe_session_id required' }, 400);

  // Verify the Stripe session
  let session;
  try {
    session = await stripeGet(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    return json({ error: 'Could not reach Stripe', detail: err.message }, 502);
  }

  if (!session.id) return json({ error: 'Invalid Stripe session' }, 404);
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return json({ error: 'Payment not complete', status: session.payment_status }, 402);
  }

  const email = (
    session.customer_details?.email ||
    session.customer_email ||
    ''
  ).toLowerCase().trim();

  // Determine plan from amount / metadata
  const amountTotal = session.amount_total || 0;           // cents
  const plan = amountTotal >= 4900 ? 'smb-plus' : 'smb-essentials';

  // Idempotency — only process once per session
  const kvKey = `smb:session:${sessionId}`;
  if (env.PULSE_KV) {
    try {
      const existing = await env.PULSE_KV.get(kvKey);
      if (existing) {
        return json({ ok: true, already_processed: true, email, plan });
      }
    } catch {}
  }

  // Record subscriber
  const subscriber = {
    email,
    plan,
    product: 'smb-bundle',
    stripe_session_id: sessionId,
    created_at: new Date().toISOString(),
    active: true,
  };

  if (env.PULSE_KV) {
    try {
      await env.PULSE_KV.put(kvKey, JSON.stringify(subscriber), {
        metadata: { email, plan, product: 'smb-bundle', created_at: subscriber.created_at },
      });
    } catch (err) {
      console.error('KV write failed:', err.message);
    }
  }

  // Send welcome email
  await sendWelcomeEmail(env, email, plan);

  return json({ ok: true, email, plan });
}
