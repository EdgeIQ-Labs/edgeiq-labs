/**
 * POST /api/webhooks/stripe-msp
 *
 * Stripe webhook handler for MSP Essentials checkout completion.
 * Verifies the Stripe-Signature header, then on checkout.session.completed:
 *   1. Stores msp:{email} in KV with 10 empty seats
 *   2. Sends a welcome email via Resend
 *
 * KV binding:  PULSE_KV
 * Env vars:    STRIPE_MSP_WEBHOOK_SECRET, RESEND_API_KEY, FROM_EMAIL, SITE_URL
 *
 * Stripe webhook: we_1TYZZFRC1NZ20yDTh9dz9bUz
 * MSP Price ID:   price_1TYZXnRC1NZ20yDTmtMZrusI
 */

const MSP_PRICE_ID = 'price_1TYZXnRC1NZ20yDTmtMZrusI';
const MSP_SEATS = 10;

// ── Stripe signature verification ──────────────────────────────────────────

function hexToUint8Array(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  try {
    const parts = {};
    for (const chunk of sigHeader.split(',')) {
      const idx = chunk.indexOf('=');
      if (idx > 0) parts[chunk.slice(0, idx)] = chunk.slice(idx + 1);
    }
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['verify']
    );
    const payload = enc.encode(`${timestamp}.${rawBody}`);
    return await crypto.subtle.verify('HMAC', key, hexToUint8Array(signature), payload);
  } catch {
    return false;
  }
}

// ── Welcome email ───────────────────────────────────────────────────────────

function buildWelcomeEmail(email, dashboardUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:36px 24px;">

  <div style="text-align:center;margin-bottom:28px;">
    <div style="display:inline-block;background:rgba(192,132,252,0.12);border:1px solid rgba(192,132,252,0.3);color:#c084fc;font-size:11px;font-weight:700;padding:4px 14px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      EdgeIQ Labs · MSP Essentials
    </div>
    <h1 style="color:#e8eef7;font-size:22px;font-weight:800;margin:0 0 10px;">Welcome aboard! 🎉</h1>
    <p style="color:#9fb0c7;font-size:14px;margin:0;">Your MSP Essentials subscription is active. You have <strong style="color:#c084fc;">10 client seats</strong> ready to fill with Pulse + Inbox Shield monitoring.</p>
  </div>

  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:14px;padding:22px;margin-bottom:22px;">
    <h2 style="color:#e8eef7;font-size:15px;font-weight:700;margin:0 0 16px;">What to do next</h2>
    <div style="display:flex;gap:12px;margin-bottom:14px;align-items:flex-start;">
      <div style="width:26px;height:26px;border-radius:50%;background:rgba(192,132,252,0.15);border:1px solid rgba(192,132,252,0.3);color:#c084fc;font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">1</div>
      <div><strong style="color:#e8eef7;font-size:13px;">Sign in to your dashboard</strong><br><span style="color:#9fb0c7;font-size:12px;">Use the button below — it logs you in directly.</span></div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:14px;align-items:flex-start;">
      <div style="width:26px;height:26px;border-radius:50%;background:rgba(192,132,252,0.15);border:1px solid rgba(192,132,252,0.3);color:#c084fc;font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">2</div>
      <div><strong style="color:#e8eef7;font-size:13px;">Add up to 10 client domains</strong><br><span style="color:#9fb0c7;font-size:12px;">Each domain gets weekly Pulse + Inbox Shield scans automatically.</span></div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="width:26px;height:26px;border-radius:50%;background:rgba(192,132,252,0.15);border:1px solid rgba(192,132,252,0.3);color:#c084fc;font-weight:800;font-size:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">3</div>
      <div><strong style="color:#e8eef7;font-size:13px;">Scans run every Monday</strong><br><span style="color:#9fb0c7;font-size:12px;">You'll receive a weekly digest email per client domain.</span></div>
    </div>
  </div>

  <div style="text-align:center;margin-bottom:24px;">
    <a href="${dashboardUrl}" style="display:inline-block;background:#c084fc;color:#1a0033;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none;">
      Go to My Dashboard →
    </a>
  </div>

  <div style="border-top:1px solid #1e2e3e;padding-top:18px;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 4px;">Questions? Reply to this email or contact <a href="mailto:hello@edgeiqlabs.com" style="color:#9fb0c7;">hello@edgeiqlabs.com</a></p>
    <p style="margin:0;">EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
  </div>
</div>
</body>
</html>`;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  const secret = env.STRIPE_MSP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[msp-webhook] STRIPE_MSP_WEBHOOK_SECRET not set');
    return new Response('Misconfigured', { status: 500 });
  }

  const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
  if (!valid) {
    console.warn('[msp-webhook] Signature verification failed');
    return new Response('Unauthorized', { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  // Only handle checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return new Response('OK', { status: 200 });
  }

  const session = event.data?.object;
  if (!session) return new Response('OK', { status: 200 });

  // Confirm this is for the MSP price
  const lineItems = session.line_items?.data || [];
  const isMsp = lineItems.some(li => li.price?.id === MSP_PRICE_ID)
    || session.metadata?.product === 'msp_essentials';

  if (!isMsp) {
    console.log('[msp-webhook] Not an MSP checkout — ignoring');
    return new Response('OK', { status: 200 });
  }

  const email = (session.customer_details?.email || '').toLowerCase().trim();
  if (!email) {
    console.error('[msp-webhook] No email in session');
    return new Response('OK', { status: 200 });
  }

  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';

  // Store / update MSP record in KV
  if (env.PULSE_KV) {
    const existing = await env.PULSE_KV.get(`msp:${email}`).catch(() => null);
    let record = existing ? JSON.parse(existing) : null;

    if (!record) {
      record = {
        plan: 'msp',
        seats: MSP_SEATS,
        clients: [],
        active: true,
        stripe_customer_id: session.customer || null,
        stripe_session_id: session.id,
        created_at: new Date().toISOString(),
      };
    } else {
      // Renewal — just ensure active
      record.active = true;
      record.stripe_customer_id = session.customer || record.stripe_customer_id;
    }

    await env.PULSE_KV.put(`msp:${email}`, JSON.stringify(record));
    console.log(`[msp-webhook] MSP record stored for ${email}`);
  }

  // Send welcome email (best-effort, only on new subscriptions)
  if (env.RESEND_API_KEY) {
    const fromEmail = env.FROM_EMAIL || 'alerts@edgeiqlabs.com';
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: `EdgeIQ Labs <${fromEmail}>`,
          to: [email],
          subject: 'Your MSP Essentials subscription is active',
          html: buildWelcomeEmail(email, `${siteUrl}/account/`),
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.error('[msp-webhook] Welcome email failed:', err.message);
    }
  }

  return new Response('OK', { status: 200 });
}
