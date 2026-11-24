/**
 * POST /api/webhooks/stripe-compliance-audit
 *
 * Stripe webhook for $499 Compliance Audit (one-time).
 * On checkout.session.completed:
 *   1. Records the purchase in KV
 *   2. Sends confirmation email with next-steps
 *   3. Triggers internal notification for audit fulfillment
 *
 * This is a PREMIUM service — the audit is delivered within 24 hours
 * as a comprehensive branded PDF with prioritized remediation.
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

  const secret = env.STRIPE_COMPLIANCE_AUDIT_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET;
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

  console.log(`[ComplianceAudit Webhook] Event: ${event.type}, ID: ${event.id}`);

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
    if (_product && !['compliance-audit'].includes(_product)) return new Response(JSON.stringify({ received: true, ignored: 'cross-product guard' }), { status: 200, headers: { 'Content-Type': 'application/json' } })('product mismatch');

  const session = event.data.object || event.data;
  const email = session.customer_email || session.customer_details?.email || session.metadata?.email;
  const domain = session.metadata?.domain || '';
  const sessionId = session.id;
  const amountTotal = session.amount_total || 49900;

  if (!email) {
    console.log('[ComplianceAudit Webhook] No email in session, skipping');
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    // Record the audit purchase in KV
    const auditId = crypto.randomUUID().slice(0, 12);
    const purchasedAt = new Date().toISOString();

    const auditRecord = {
      id: auditId,
      email,
      domain,
      session_id: sessionId,
      amount: amountTotal / 100,
      purchased_at: purchasedAt,
      status: 'pending_fulfillment',
      sla_deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    await env.PULSE_KV.put(`compliance-audit:${auditId}`, JSON.stringify(auditRecord), { expirationTtl: 86400 * 365 });
    await env.PULSE_KV.put(`compliance-audit:email:${email}`, auditId, { expirationTtl: 86400 * 365 });
    if (domain) {
      await env.PULSE_KV.put(`compliance-audit:domain:${domain}`, auditId, { expirationTtl: 86400 * 365 });
    }

    // Send confirmation email
    if (env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'EdgeIQ Labs Compliance <compliance@edgeiqlabs.com>',
          to: [email],
          subject: `✅ Compliance Audit Confirmed — Your audit is in progress [${auditId}]`,
          html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">
  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:16px;padding:36px 32px;text-align:center;">
    <div style="font-size:3rem;margin-bottom:16px;">🔍</div>
    <h1 style="color:#3de19e;font-size:1.5rem;margin:0 0 10px;">Compliance Audit Confirmed</h1>
    <p style="color:#9fb0c7;font-size:0.95rem;margin:0 0 20px;line-height:1.6;">Thank you for purchasing the EdgeIQ Compliance Audit. Our team is now analyzing <strong style="color:#e8eef7;">${domain || 'your infrastructure'}</strong> against SOC 2, HIPAA, and PCI-DSS frameworks.</p>
    <div style="background:#0b0f14;border:1px solid #1e2e3e;border-radius:10px;padding:20px;margin:0 0 24px;text-align:left;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9fb0c7;font-size:0.85rem;">Audit ID</span><span style="color:#e8eef7;font-weight:600;font-size:0.85rem;">${auditId}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9fb0c7;font-size:0.85rem;">Amount Paid</span><span style="color:#3de19e;font-weight:600;font-size:0.85rem;">$${(amountTotal/100).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#9fb0c7;font-size:0.85rem;">Delivery SLA</span><span style="color:#ff8c42;font-weight:600;font-size:0.85rem;">Within 24 hours</span></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:#9fb0c7;font-size:0.85rem;">Status</span><span style="color:#3dd9ff;font-weight:600;font-size:0.85rem;">In Progress</span></div>
    </div>
    <h3 style="color:#e8eef7;font-size:1rem;margin:0 0 12px;text-align:left;">What's included:</h3>
    <ul style="text-align:left;color:#9fb0c7;font-size:0.88rem;line-height:1.8;padding-left:20px;margin:0 0 24px;">
      <li>Full security posture assessment across all detected services</li>
      <li>Prioritized remediation playbook with code-level fix guidance</li>
      <li>SOC 2 / HIPAA / PCI-DSS compliance mapping matrix</li>
      <li>Executive summary for stakeholder presentation</li>
      <li>Print-ready branded PDF report</li>
    </ul>
    <p style="color:#9fb0c7;font-size:0.85rem;margin:0;">Your comprehensive audit report will be delivered to this email within 24 hours. Questions? Reply directly to this email.</p>
  </div>
  <p style="text-align:center;color:#64748b;font-size:0.75rem;margin-top:24px;">EdgeIQ Labs · Secure compliance automation<br>This is an automated confirmation. Your audit is being processed.</p>
</div>
</body></html>`
        })
      });
    }

    // Notify internal team via ntfy if configured
    if (env.NTFY_TOPIC) {
      await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
        method: 'POST',
        headers: { 'Title': '💰 $499 Compliance Audit Sold', 'Priority': '1' },
        body: `New compliance audit purchased!\n\nEmail: ${email}\nDomain: ${domain || 'not specified'}\nAudit ID: ${auditId}\nAmount: $${(amountTotal/100).toFixed(2)}\nSLA: 24 hours`
      });
    }

    console.log(`[ComplianceAudit Webhook] ✅ Audit ${auditId} recorded for ${email}, domain: ${domain || 'none'}`);
    return new Response(JSON.stringify({ received: true, audit_id: auditId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error(`[ComplianceAudit Webhook] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
