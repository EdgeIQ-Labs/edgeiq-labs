// ShieldVerify Webhook — POST /api/shieldverify/webhook
// Handles Stripe checkout.session.completed: creates KV account, sends Resend welcome email

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const kv = context.env.SHIELDVERIFY_KV;
  const resendKey = context.env.RESEND_API_KEY;

  if (!kv) return json({ error: 'KV namespace not bound' }, 500);
  if (!resendKey) return json({ error: 'Email service not configured' }, 500);

  try {
    const body = await context.request.text();
    const event = JSON.parse(body);

    if (event.type !== 'checkout.session.completed') {
      return json({ received: true, skipped: event.type });
    }

    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountTotal = session.amount_total;

    // Determine tier from price ($99=9900, $249=24900)
    const tier = amountTotal >= 24900 ? 'pro' : 'starter';
    const planName = tier === 'pro' ? 'Pro' : 'Starter';
    const monthlyPrice = tier === 'pro' ? 249 : 99;

    if (!customerEmail) {
      return json({ error: 'No customer email in session' }, 400);
    }

    // Check if user already exists
    const userKey = `users:${customerEmail.toLowerCase()}`;
    let userData = await kv.get(userKey, 'json');

    if (!userData) {
      const userId = crypto.randomUUID();
      const tempPassword = 'TempPass-' + Math.random().toString(36).slice(-8) + '!';

      userData = {
        id: userId,
        email: customerEmail.toLowerCase(),
        name: customerEmail.split('@')[0],
        password: tempPassword,
        tier: tier,
        stripeCustomerId: session.customer,
        subscriptionId: session.subscription,
        createdAt: new Date().toISOString(),
      };

      await kv.put(userKey, JSON.stringify(userData));

      // Add to users index
      const usersIndex = await kv.get('users:index', 'json') || [];
      usersIndex.push({ id: userId, email: customerEmail.toLowerCase(), tier });
      await kv.put('users:index', JSON.stringify(usersIndex));
    } else {
      userData.tier = tier;
      userData.stripeCustomerId = session.customer;
      userData.subscriptionId = session.subscription;
      await kv.put(userKey, JSON.stringify(userData));
    }

    // Send welcome email via Resend
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: #0c0c14; padding: 32px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome to ShieldVerify</h1>
          <p style="color: #a0a0a0; margin: 8px 0 0;">Backup Verification Service</p>
        </div>
        <div style="background: #f8f9fa; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0; border-top: none;">
          <p>Hi ${userData.name},</p>
          <p>Thank you for subscribing to <strong>ShieldVerify ${planName}</strong>. Your payment of <strong>$${monthlyPrice}/mo</strong> has been confirmed.</p>

          <div style="background: #e8f4fd; padding: 16px; border-radius: 6px; margin: 24px 0; border-left: 4px solid #3dd9ff;">
            <strong>Your Login Credentials:</strong><br/>
            Email: ${customerEmail}<br/>
            Temporary Password: <code>${userData.password}</code><br/><br/>
            <a href="https://edgeiqlabs.com/shieldverify/dashboard.html" style="display: inline-block; background: #3dd9ff; color: #0b0f14; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Go to Dashboard</a>
          </div>

          <h3 style="margin-top: 24px; color: #0c0c14;">What's included in ${planName}:</h3>
          <ul style="line-height: 1.8;">
            ${tier === 'pro'
              ? '<li>25 servers monitored</li><li>Weekly restore tests</li><li>Ransomware resilience scoring</li><li>Compliance reports (SOC2, HIPAA)</li><li>API access</li><li>Priority support</li>'
              : '<li>5 servers monitored</li><li>Monthly restore tests</li><li>Checksum audit validation</li><li>Email alerts on failure</li><li>Standard support</li>'}
          </ul>

          <p style="margin-top: 24px; font-size: 14px; color: #64748b;">
            Questions? Reply to this email or contact us at <a href="mailto:verify@edgeiqlabs.com" style="color: #3dd9ff;">verify@edgeiqlabs.com</a>.
          </p>
        </div>
      </div>
    `;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ShieldVerify <verify@edgeiqlabs.com>',
        to: [customerEmail],
        subject: `Welcome to ShieldVerify — ${planName} Plan Activated`,
        html: emailHtml,
      }),
    });

    if (!emailResponse.ok) {
      const errText = await emailResponse.text();
      console.error('Resend API error:', errText);
      return json({ error: 'Failed to send welcome email', details: errText }, 500);
    }

    const emailResult = await emailResponse.json();
    console.log(`Welcome email sent to ${customerEmail}: ${emailResult.id}`);

    return json({
      received: true,
      email_sent: true,
      email_id: emailResult.id,
      customer: customerEmail,
      tier: tier,
      user_created: !userData.subscriptionId,
    });

  } catch (err) {
    console.error('Webhook processing error:', err);
    return json({ error: 'Internal server error', message: err.message }, 500);
  }
}
