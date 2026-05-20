/**
 * EdgeIQ Pulse — Sign-up API
 * POST /api/pulse-signup
 * Body: { email, domain, plan, stripe_session_id? }
 *
 * - Free plan: no Stripe required.
 * - Pro/Business plan: requires a valid completed Stripe Checkout session_id
 *   that matches the submitting email. Without it the request is rejected 402.
 *
 * KV binding: PULSE_KV
 * Env vars:   STRIPE_SECRET_KEY, RESEND_API_KEY
 */

async function sendWelcomeEmail(env, email, domain, plan, nextScanDate) {
  if (!env.RESEND_API_KEY || plan === 'free') return;
  const bg = '#0b0f14', card = '#121923', text = '#e8eef7', muted = '#9fb0c7', border = '#1e2e3e', accent = '#3dd9ff';
  const planLabel = plan === 'business' ? 'Business' : 'Pro';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${bg};font-family:Inter,system-ui,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="padding:0 0 24px;"><span style="font-size:18px;font-weight:800;color:${text};">EdgeIQ<span style="color:${accent}"> Labs</span></span></td></tr>
    <tr><td style="background:${card};border:1px solid ${border};border-radius:14px;padding:32px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${accent};margin-bottom:12px;">🟢 Pulse ${planLabel} Active</div>
      <h1 style="font-size:22px;font-weight:800;color:${text};margin:0 0 12px;">${domain} is now being monitored</h1>
      <p style="font-size:14px;color:${muted};line-height:1.7;margin:0 0 24px;">Pulse runs every Monday at 08:00 UTC — your first automated scan runs on <strong style="color:${text};">${nextScanDate}</strong>. You'll get an email digest any week something changes.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        ${[
          ['SSL certificate','Grade, expiry date, issuer, and any configuration issues'],
          ['HTTP security headers','CSP, HSTS, X-Frame-Options, Referrer-Policy and more'],
          ['DNS health','SPF, DMARC, MX records and zone transfer exposure'],
          ['Subdomain exposure','New subdomains, dangling DNS, and takeover risk'],
          ['Open ports','Exposed admin panels, databases, and dev services'],
        ].map(([t,b]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${border};">
          <div style="font-size:13px;font-weight:700;color:${text};margin-bottom:2px;">${t}</div>
          <div style="font-size:12px;color:${muted};">${b}</div>
        </td></tr>`).join('')}
      </table>
      <a href="https://edgeiqlabs.com/dashboard/" style="display:inline-block;background:${accent};color:#071018;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Run a manual scan now →</a>
    </td></tr>
    <tr><td style="padding:20px 0 0;text-align:center;font-size:11px;color:#4a6080;">
      © 2026 EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a>
    </td></tr>
  </table></td></tr></table>
  </body></html>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'EdgeIQ Labs <security@edgeiqlabs.com>', to: [email], subject: `Pulse ${planLabel} active — ${domain} is now monitored`, html }),
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

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function isValidDomain(d) {
  return /^[a-zA-Z0-9][a-zA-Z0-9\-\.]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(d);
}

/**
 * Verify a Stripe Checkout Session is paid and optionally matches the email.
 * Returns true if valid, false otherwise.
 */
async function verifyStripeSession(env, sessionId, email) {
  if (!env.STRIPE_SECRET_KEY) return false;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 10) return false;
  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!resp.ok) return false;
    const session = await resp.json();

    // Must be a completed / paid session
    if (session.payment_status !== 'paid' && session.status !== 'complete') return false;

    // Email must match (if Stripe captured one)
    const stripeEmail = (
      session.customer_details?.email ||
      session.customer_email ||
      ''
    ).toLowerCase().trim();

    if (stripeEmail && stripeEmail !== email) return false;

    return true;
  } catch {
    return false;
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/$/, '');
  const rawPlan = (body.plan || 'free').trim().toLowerCase();
  const stripeSessionId = (body.stripe_session_id || '').trim();

  if (!isValidEmail(email)) return json({ error: 'Invalid email address.' }, 400);
  if (!isValidDomain(domain)) return json({ error: 'Invalid domain. Use format: example.com' }, 400);
  if (!['free', 'pro', 'business'].includes(rawPlan)) return json({ error: 'Invalid plan.' }, 400);

  // ── Paid-plan gate ───────────────────────────────────────────────────────────
  let plan = rawPlan;
  if (plan === 'pro' || plan === 'business') {
    if (!stripeSessionId) {
      return json({
        error: 'A completed Stripe checkout session is required for paid plans.',
        hint: 'Complete the checkout at edgeiqlabs.com/pulse/ first.',
      }, 402);
    }
    const valid = await verifyStripeSession(env, stripeSessionId, email);
    if (!valid) {
      return json({
        error: 'Could not verify Stripe payment. Please complete checkout or contact support@edgeiqlabs.com.',
      }, 402);
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  const subscriber = {
    email,
    domain,
    plan,
    created_at: new Date().toISOString(),
    last_scan: null,
    last_findings: {},
    active: true,
    ...(stripeSessionId && { stripe_session_id: stripeSessionId }),
  };

  const kvKey = `sub:${email}:${domain}`;

  if (env.PULSE_KV) {
    try {
      await env.PULSE_KV.put(kvKey, JSON.stringify(subscriber), {
        metadata: { email, domain, plan, created_at: subscriber.created_at },
      });
    } catch (err) {
      console.error('KV write failed:', err.message);
      // Continue — don't fail the user if KV is temporarily unavailable
    }
  }

  // Compute next scan date (next Monday at 08:00 UTC)
  const now = new Date();
  const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
  const nextScan = new Date(now);
  nextScan.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextScan.setUTCHours(8, 0, 0, 0);

  const nextScanDate = nextScan.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });
  await sendWelcomeEmail(env, email, domain, plan, nextScanDate);

  return json({
    ok: true,
    message: `Registered ${domain} for ${plan} monitoring.`,
    next_scan: nextScan.toISOString().split('T')[0],
    domain,
    plan,
  });
}
