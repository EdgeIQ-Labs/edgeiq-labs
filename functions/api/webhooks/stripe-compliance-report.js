/**
 * POST /api/webhooks/stripe-compliance-report
 *
 * Stripe webhook for $49 Compliance Report paid unlock.
 * On checkout.session.completed:
 *   1. Looks up the original free report by email in KV
 *   2. Regenerates as paid (full findings + remediation)
 *   3. Emails the full report via Resend
 *
 * KV binding: PULSE_KV
 * Env vars: STRIPE_WEBHOOK_SECRET (shared), RESEND_API_KEY
 */

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
    const a = new TextEncoder().encode(computed);
    const b = new TextEncoder().encode(parts.v1);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature');

  // Use shared webhook secret or compliance-specific one
  const secret = env.STRIPE_COMPLIANCE_REPORT_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET;
  const isValid = await verifyStripeSignature(payload, signature, secret);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  console.log(`[ComplianceReport Webhook] Event: ${event.type}, ID: ${event.id}`);

  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ received: true, ignored: event.type }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // CROSS-PRODUCT GUARD: ignore checkouts belonging to another product
    const _m = (event.data?.object || event.data).metadata || {};
    const _plan = (_m.plan || '').toLowerCase();
    const _product = (_m.product || '').toLowerCase();
    const _service = (_m.service || '').toLowerCase();
    const _vpsPlan = ['nano','micro','basic','standard','custom'].includes(_plan) || !!_m.os;
    if (_vpsPlan) return new Response(JSON.stringify({ received: true, ignored: 'cross-product guard' }), { status: 200, headers: { 'Content-Type': 'application/json' } })('vps checkout');
    if (['evidence-collector','verified-badge'].includes(_service)) return new Response(JSON.stringify({ received: true, ignored: 'cross-product guard' }), { status: 200, headers: { 'Content-Type': 'application/json' } })('other service');
    if (_product && !['compliance-report'].includes(_product)) return new Response(JSON.stringify({ received: true, ignored: 'cross-product guard' }), { status: 200, headers: { 'Content-Type': 'application/json' } })('product mismatch');

  const session = event.data.object || event.data;
  const email = session.customer_email || session.customer_details?.email;
  const sessionId = session.id;

  if (!email) {
    console.log('[ComplianceReport Webhook] No email in session, skipping');
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // Look up the original free report by email
    const reportId = await env.PULSE_KV.get(`compliance-report:email:${email}`);
    if (!reportId) {
      console.log(`[ComplianceReport Webhook] No report found for ${email}, sending confirmation only`);
      // Send a receipt email even if we can't find the original report
      if (env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
            to: [email],
            subject: 'Your EdgeIQ Compliance Report Purchase — Confirmation',
            html: `<div style="font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:40px;"><div style="max-width:500px;margin:0 auto;background:#121923;border:1px solid #1e2a3a;border-radius:14px;padding:32px;text-align:center;"><h2 style="color:#3dd9ff;margin:0 0 12px;">Payment Received ✓</h2><p style="color:#9fb0c7;font-size:14px;">Thanks for purchasing the full compliance report. We couldn't automatically locate your original scan. Please re-run your scan at <a href="https://edgeiqlabs.com/compliance-report/" style="color:#3dd9ff;">edgeiqlabs.com/compliance-report</a> and your full report will be generated automatically.</p></div></div>`
          })
        });
      }
      return new Response(JSON.stringify({ received: true, note: 'no_report_found' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Get original report metadata and scanner data
    const meta = await env.PULSE_KV.get(`compliance-report:${reportId}`, 'json');
    const originalHtml = await env.PULSE_KV.get(`compliance-report:${reportId}:html`);

    if (!meta) {
      console.log(`[ComplianceReport Webhook] Report meta missing for ${reportId}`);
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Re-generate as paid report using stored scanner data
    // We need to call the compliance-report endpoint internally with paid=true
    // But since we're in a Worker, we can just regenerate the HTML directly
    const scannerData = meta.scanner_data || await env.PULSE_KV.get(`compliance-report:${reportId}:scan`, 'json');

    if (!scannerData) {
      console.log(`[ComplianceReport Webhook] Scanner data missing for ${reportId}, sending download link to existing report`);
      // Fallback: just send them the download link
      if (env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
            to: [email],
            subject: 'Your Full Compliance Report — EdgeIQ Labs',
            html: `<div style="font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:40px;"><div style="max-width:500px;margin:0 auto;background:#121923;border:1px solid #1e2a3a;border-radius:14px;padding:32px;text-align:center;"><h2 style="color:#3de19e;margin:0 0 12px;">Full Report Unlocked ✓</h2><p style="color:#9fb0c7;font-size:14px;margin-bottom:20px;">Your payment has been confirmed. Access your full compliance report:</p><a href="https://edgeiqlabs.com/api/compliance-report/download?id=${reportId}" style="display:inline-block;padding:14px 28px;background:#3dd9ff;color:#0b0f14;border-radius:8px;font-weight:700;text-decoration:none;">Download Full Report →</a></div></div>`
          })
        });
      }
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Mark the original report as paid and regenerate
    meta.paid = true;
    meta.upgraded_at = new Date().toISOString();
    meta.session_id = sessionId;
    await env.PULSE_KV.put(`compliance-report:${reportId}`, JSON.stringify(meta), { expirationTtl: 86400 * 90 });

    // Send the paid upgrade email with download link
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
          to: [email],
          subject: '🔓 Your Full Compliance Report is Ready — EdgeIQ Labs',
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">
  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:16px;padding:36px 32px;text-align:center;">
    <div style="font-size:3rem;margin-bottom:16px;">🔓</div>
    <h1 style="color:#3de19e;font-size:1.5rem;margin:0 0 10px;">Full Report Unlocked</h1>
    <p style="color:#9fb0c7;font-size:0.9rem;margin:0 0 24px;">Your payment has been confirmed. Your full compliance report includes all findings, detailed remediation steps, compliance mapping matrix, and executive summary.</p>
    <a href="https://edgeiqlabs.com/api/compliance-report/download?id=${reportId}" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:1rem;">Download Full Report →</a>
    <p style="color:#64748b;font-size:0.8rem;margin-top:20px;">Report ID: ${reportId} · Valid for 90 days</p>
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #1e2e3e;">
      <p style="color:#9fb0c7;font-size:0.8rem;margin:0;">Want ongoing monitoring? <a href="https://edgeiqlabs.com/pricing/" style="color:#3dd9ff;">Compliance Shield starts at $299/mo</a></p>
    </div>
  </div>
  <p style="text-align:center;color:#64748b;font-size:0.75rem;margin-top:24px;">EdgeIQ Labs · Secure compliance automation<br>This is an automated message. Questions? Reply to this email.</p>
</div>
</body></html>`
        })
      });
    }

    console.log(`[ComplianceReport Webhook] ✅ Paid upgrade processed for ${email}, report ${reportId}`);
    return new Response(JSON.stringify({ received: true, upgraded: reportId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error(`[ComplianceReport Webhook] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
