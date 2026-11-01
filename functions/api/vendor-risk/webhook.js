// Vendor Risk Assessment — Stripe Webhook Handler
// Sends welcome/onboarding email on checkout.session.completed

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

  try {
    const body = await context.request.text();
    const event = JSON.parse(body);

    // Only handle checkout.session.completed
    if (event.type !== 'checkout.session.completed') {
      return json({ received: true, skipped: event.type });
    }

    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const amountTotal = session.amount_total; // in cents
    const planName = amountTotal >= 99900 ? 'Professional' : 'Starter';
    const vendorLimit = amountTotal >= 99900 ? 50 : 15;

    if (!customerEmail) {
      return json({ error: 'No customer email in session' }, 400);
    }

    // Send welcome email via Resend
    const resendKey = context.env.RESEND_API_KEY;
    if (!resendKey) {
      console.error('RESEND_API_KEY not configured');
      return json({ error: 'Email service not configured' }, 500);
    }

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: #0c0c14; padding: 32px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome to EdgeIQ Vendor Risk</h1>
        </div>
        <div style="background: #f8f9fa; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0; border-top: none;">
          <p>Hi there,</p>
          <p>Thank you for subscribing to <strong>Vendor Risk Assessment ${planName}</strong>. Your payment of <strong>$${(amountTotal / 100).toFixed(0)}/mo</strong> has been confirmed.</p>
          
          <h3 style="margin-top: 24px; color: #0c0c14;">What happens next?</h3>
          <ol style="line-height: 1.8;">
            <li><strong>Vendor Intake:</strong> Reply to this email with a list of vendors you'd like us to assess (up to ${vendorLimit} included in your plan).</li>
            <li><strong>Initial Assessment:</strong> We'll run HIPAA-native security assessments on each vendor within 5-7 business days.</li>
            <li><strong>Report Delivery:</strong> You'll receive a detailed PDF report with risk scores, BAA verification status, and remediation recommendations.</li>
            <li><strong>Continuous Monitoring:</strong> We'll alert you immediately if any monitored vendor experiences a breach or security incident.</li>
          </ol>

          <div style="background: #e8f4fd; padding: 16px; border-radius: 6px; margin: 24px 0; border-left: 4px solid #3b82f6;">
            <strong>Need help getting started?</strong><br/>
            Simply reply to this email with your vendor list, or contact us at <a href="mailto:compliance@edgeiqlabs.com" style="color: #2563eb;">compliance@edgeiqlabs.com</a>.
          </div>

          <p style="margin-top: 24px; font-size: 14px; color: #64748b;">
            EdgeIQ Labs Compliance Team<br/>
            <a href="https://edgeiqlabs.com" style="color: #2563eb;">edgeiqlabs.com</a>
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
        from: 'EdgeIQ Labs Compliance <compliance@edgeiqlabs.com>',
        to: [customerEmail],
        subject: `Welcome to Vendor Risk Assessment — ${planName} Plan`,
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
      plan: planName 
    });

  } catch (err) {
    console.error('Webhook processing error:', err);
    return json({ error: 'Internal server error', message: err.message }, 500);
  }
}
