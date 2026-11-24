/**
 * Stripe Webhook — Evidence Collector Provisioning
 * Handles checkout.session.completed for evidence-collector subscriptions.
 * 
 * Stores org record in COMPLIANCE_KV:
 *   evidence:org:{org_id} → { email, org_name, plan, status, created_at }
 *   evidence:email:{email} → org_id
 * 
 * Sends welcome email via Resend with org credentials.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function verifyStripeSignature(payload, signature, secret) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const sig = parts.find(p => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !sig) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    'HMAC', false, ['sign']
  );
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expectedHex = Array.from(new Uint8Array(expected)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expectedHex === sig;
}

async function sendWelcomeEmail(env, email, orgId, orgName) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'compliance@edgeiqlabs.com',
        to: [email],
        subject: `Your Compliance Evidence Collector is ready — ${orgName}`,
        html: `
          <div style="font-family:Inter,system-ui,sans-serif;background:#060a0f;color:#e8eef7;padding:32px;">
            <h1 style="color:#3dd9ff;margin-bottom:16px;">📋 Evidence Collector Activated</h1>
            <p>Your organization <strong>${orgName}</strong> is now subscribed to the Compliance Evidence Collector.</p>
            <div style="background:#0f1620;border:2px solid #3dd9ff;border-radius:12px;padding:20px;margin:24px 0;">
              <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.1em;color:#3dd9ff;margin-bottom:8px;">Your Organization ID</div>
              <div style="font-family:monospace;font-size:1rem;word-break:break-all;">${orgId}</div>
            </div>
            <p>Use this ID to log into your evidence dashboard at:</p>
            <a href="https://edgeiqlabs.com/evidence-collector/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;margin-top:12px;">Open Dashboard →</a>
            <p style="margin-top:24px;color:#9fb0c7;font-size:0.85rem;">Questions? Reply to this email or contact support@edgeiqlabs.com</p>
          </div>
        `,
      }),
    });
  } catch {}
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const { request, env } = context;
  const payload = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';

  // Verify signature if secret is configured
  if (env.EVIDENCE_COLLECTOR_WEBHOOK_SECRET) {
    const valid = await verifyStripeSignature(payload, sigHeader, env.EVIDENCE_COLLECTOR_WEBHOOK_SECRET);
    if (!valid) return json({ error: 'Invalid signature' }, 400);
  }

  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'Bad JSON' }, 400); }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true, ignored: true });
  }

  // CROSS-PRODUCT GUARD: ignore checkouts belonging to another product
    const _m = (event.data?.object || event.data).metadata || {};
    const _plan = (_m.plan || '').toLowerCase();
    const _product = (_m.product || '').toLowerCase();
    const _service = (_m.service || '').toLowerCase();
    const _vpsPlan = ['nano','micro','basic','standard','custom'].includes(_plan) || !!_m.os;
    if (_vpsPlan) return json({ received: true, ignored: 'cross-product guard' });
    if (_service && _service !== 'evidence-collector') return json({ received: true, ignored: 'cross-product guard' });
    if (_product && !['evidence-collector'].includes(_product)) return json({ received: true, ignored: 'cross-product guard' });

  const session = event.data.object;
  const isEvidenceCollector =
    session.metadata?.service === 'evidence-collector' ||
    session.subscription_details?.metadata?.service === 'evidence-collector';

  if (!isEvidenceCollector) {
    return json({ received: true, ignored: true });
  }

  const email = session.customer_details?.email || session.customer_email || '';
  const orgName = session.metadata?.org_name || 'Organization';
  const orgId = 'ec_' + crypto.randomUUID().slice(0, 12);

  // Store org record
  const orgRecord = {
    org_id: orgId,
    email,
    org_name: orgName,
    plan: 'evidence-collector',
    price: 99,
    currency: 'usd',
    interval: 'month',
    status: 'active',
    stripe_session_id: session.id,
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.subscription || null,
    created_at: new Date().toISOString(),
  };

  await env.COMPLIANCE_KV.put(`evidence:org:${orgId}`, JSON.stringify(orgRecord), {
    expirationTtl: 86400 * 365,
  });
  await env.COMPLIANCE_KV.put(`evidence:email:${email.toLowerCase()}`, orgId, {
    expirationTtl: 86400 * 365,
  });

  // Send welcome email
  await sendWelcomeEmail(env, email, orgId, orgName);

  return json({ received: true, provisioned: orgId });
}
