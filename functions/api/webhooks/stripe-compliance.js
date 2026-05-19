/**
 * POST /api/webhooks/stripe-compliance
 *
 * Stripe webhook for Compliance Pro checkout completion.
 * On checkout.session.completed:
 *   1. Stores compliance:{email}:{domain} in KV with plan: 'pro'
 *   2. Sends welcome email via Resend
 *
 * KV binding : PULSE_KV
 * Env vars   : STRIPE_COMPLIANCE_WEBHOOK_SECRET, RESEND_API_KEY, FROM_EMAIL, SITE_URL
 *
 * Register at: https://dashboard.stripe.com/webhooks
 * Events:      checkout.session.completed
 * Endpoint:    https://edgeiqlabs.com/api/webhooks/stripe-compliance
 */

function hexToUint8(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  try {
    const parts = {};
    for (const c of sigHeader.split(',')) {
      const i = c.indexOf('=');
      if (i > 0) parts[c.slice(0, i)] = c.slice(i + 1);
    }
    if (!parts.t || !parts.v1) return false;
    const payload = `${parts.t}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === parts.v1;
  } catch { return false; }
}

async function sendWelcomeEmail(env, email, domain) {
  if (!env.RESEND_API_KEY) return;
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'alerts@edgeiqlabs.com',
      to: email,
      subject: `Compliance Pro activated for ${domain} — EdgeIQ Labs`,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">
  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:16px;padding:36px 32px;text-align:center;">
    <div style="font-size:3rem;margin-bottom:16px;">📋</div>
    <h1 style="color:#e8eef7;font-size:1.5rem;margin:0 0 10px;">Compliance monitoring is live</h1>
    <p style="color:#9fb0c7;font-size:0.9rem;margin:0 0 24px;">Your first automated scan of <strong style="color:#3dd9ff;">${domain}</strong> will run shortly. Every Monday at 8:00 AM UTC you'll receive a full compliance digest.</p>
    <a href="${siteUrl}/compliance/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:12px 28px;border-radius:9px;text-decoration:none;">Open Compliance Dashboard →</a>
    <p style="margin:20px 0 0;font-size:0.75rem;color:#4a6080;">
      <a href="${siteUrl}/account/" style="color:#3dd9ff;">Manage subscription</a> ·
      <a href="mailto:support@edgeiqlabs.com" style="color:#4a6080;">support@edgeiqlabs.com</a>
    </p>
  </div>
</div></body></html>`,
    }),
  }).catch(e => console.error('Resend failed:', e.message));
}

export async function onRequestPost({ request, env }) {
  const rawBody  = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_COMPLIANCE_WEBHOOK_SECRET);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON', { status: 400 }); }

  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const session = event.data?.object || {};
  const email   = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
  const domain  = (session.metadata?.domain || '').trim().toLowerCase();

  if (!email || !domain) {
    console.warn('Compliance webhook: missing email or domain in session', session.id);
    return new Response(JSON.stringify({ received: true, warning: 'missing email/domain' }), { headers: { 'Content-Type': 'application/json' } });
  }

  const record = {
    email, domain, plan: 'pro', active: true,
    created_at:         new Date().toISOString(),
    last_scan_at:       null,
    last_score:         null,
    last_grade:         null,
    last_controls:      null,
    scan_count:         0,
    stripe_customer_id: session.customer || null,
    stripe_session_id:  session.id,
  };

  if (env.PULSE_KV) {
    await env.PULSE_KV.put(
      `compliance:${email}:${domain}`,
      JSON.stringify(record),
      { metadata: { email, domain, plan: 'pro', created_at: record.created_at } }
    ).catch(e => console.error('KV write failed:', e.message));
  }

  await sendWelcomeEmail(env, email, domain);

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
}
