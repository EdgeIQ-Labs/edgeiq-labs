/**
 * POST /api/email-suite/provision — Stripe webhook handler for Email Security Suite
 * Handles checkout.session.completed and invoice.payment_succeeded events
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  if (!signature || !env.EMAIL_SUITE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Missing signature or secret' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Verify webhook signature (manual HMAC-SHA256 since we can't import stripe SDK in CF Pages)
  try {
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1];
    const sig = parts.find(p => p.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !sig) {
      return new Response(JSON.stringify({ error: 'Invalid signature format' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.EMAIL_SUITE_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (expected !== sig) {
      return new Response(JSON.stringify({ error: 'Signature mismatch' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Reject if timestamp is older than 5 minutes (replay protection)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      return new Response(JSON.stringify({ error: 'Timestamp too old' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Verification failed: ' + err.message }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Parse event
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const eventType = event.type;
  if (eventType !== 'checkout.session.completed' && eventType !== 'invoice.payment_succeeded') {
    return new Response(JSON.stringify({ received: true, ignored: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const session = event.data.object;
  const customerEmail = session.customer_email || session.customer_details?.email;
  const subscriptionId = session.subscription || null;
  const customerId = session.customer || null;

  if (!customerEmail) {
    return new Response(JSON.stringify({ error: 'No customer email in event' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const kv = env.EMAIL_SUITE_KV;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Idempotency check
  const existing = await kv.get(`sub:${customerEmail}`, 'json');
  if (existing && existing.status === 'active') {
    return new Response(JSON.stringify({ received: true, already_active: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Store subscription
  const subData = {
    status: 'active',
    subscription_id: subscriptionId,
    stripe_customer_id: customerId,
    granted_at: new Date().toISOString(),
    plan: 'bundle',
    email: customerEmail,
  };

  await kv.put(`sub:${customerEmail}`, JSON.stringify(subData));

  // Update suite index
  let index = [];
  try {
    index = (await kv.get('suite_index', 'json')) || [];
  } catch { index = []; }
  if (!index.includes(customerEmail)) {
    index.push(customerEmail);
    await kv.put('suite_index', JSON.stringify(index));
  }

  // Send welcome email via Resend
  if (env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'security@edgeiqlabs.com',
          to: [customerEmail],
          subject: 'Your Email Security Suite is active',
          html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e;">
            <h2 style="color:#0b0f14;">Welcome to Email Security Suite</h2>
            <p>Your subscription is active. You now have access to:</p>
            <ul>
              <li><strong>Phishing Analyzer Pro</strong> — Unlimited analysis at <a href="https://edgeiqlabs.com/dashboard/">edgeiqlabs.com/dashboard</a></li>
              <li><strong>Header Inspector</strong> — Monitor up to 50 domains</li>
              <li><strong>DMARC/SPF Monitor</strong> — Real-time DNS change alerts</li>
              <li><strong>Weekly Security Score</strong> — Delivered every Monday</li>
            </ul>
            <p><a href="https://edgeiqlabs.com/dashboard/" style="display:inline-block;padding:12px 24px;background:#3de19e;color:#071018;font-weight:700;border-radius:8px;text-decoration:none;">Go to Dashboard →</a></p>
            <p style="margin-top:24px;font-size:0.85rem;color:#666;">Questions? Reply to this email or visit our <a href="https://edgeiqlabs.com/blog/">blog</a> for setup guides.</p>
            <p style="font-size:0.78rem;color:#999;">© 2026 EdgeIQ Labs</p>
          </div>`,
        }),
      });
    } catch (emailErr) {
      // Log but don't fail the webhook
      console.error('Welcome email failed:', emailErr);
    }
  }

  return new Response(JSON.stringify({ received: true, provisioned: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
