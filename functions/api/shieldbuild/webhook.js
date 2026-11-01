// ShieldBuild Stripe Webhook Handler
// Sends welcome email via Resend on checkout.session.completed

export async function onRequest(context) {
  const { request } = context;
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const STRIPE_WEBHOOK_SECRET = context.env.STRIPE_SHIELDBUILD_WEBHOOK_SECRET;
  const RESEND_API_KEY = context.env.RESEND_API_KEY;
  
  if (!STRIPE_WEBHOOK_SECRET || !RESEND_API_KEY) {
    console.error('Missing STRIPE_SHIELDBUILD_WEBHOOK_SECRET or RESEND_API_KEY');
    return new Response('Server misconfiguration', { status: 500 });
  }

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // Verify webhook signature using Web Crypto API
  try {
    const parts = signature.split(',');
    const timestamp = parts.find(p => p.startsWith('t='))?.substring(2);
    const sig = parts.find(p => p.startsWith('v1='))?.substring(3);
    
    if (!timestamp || !sig) {
      return new Response('Invalid signature format', { status: 400 });
    }
    
    const signedPayload = `${timestamp}.${rawBody}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(STRIPE_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const expectedSig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    if (expectedHex !== sig) {
      console.error('Webhook signature verification failed');
      return new Response('Invalid signature', { status: 400 });
    }
  } catch (e) {
    console.error('Signature verification error:', e);
    return new Response('Signature verification failed', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const productName = session.metadata?.product_name || 'ShieldBuild';
    const tier = session.metadata?.tier || 'crew';
    
    if (!customerEmail) {
      console.error('No customer email in session');
      return new Response('OK', { status: 200 });
    }

    // Tier-specific onboarding details
    const tierDetails = {
      crew: {
        name: 'Crew',
        features: 'Daily site logs, inspection checklists, incident reporting',
        nextSteps: 'Log in to your dashboard to set up your first job site and invite crew members.'
      },
      builder: {
        name: 'Builder',
        features: 'Everything in Crew + OSHA 300 log generation, compliance calendar, multi-site management',
        nextSteps: 'Set up your compliance calendar and configure OSHA 300 auto-generation for your active projects.'
      },
      healthcare_constructor: {
        name: 'Healthcare Constructor',
        features: 'Everything in Builder + ICRA compliance module, HIPAA-adjacent safety protocols, healthcare facility inspections',
        nextSteps: 'Configure ICRA compliance templates for your healthcare construction projects. Your dedicated onboarding specialist will reach out within 24 hours.'
      }
    };

    const tierInfo = tierDetails[tier] || tierDetails.crew;

    // Send welcome email via Resend
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
        <div style="background: #0C0C14; padding: 32px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Welcome to ShieldBuild</h1>
          <p style="color: #a0a0a0; margin: 8px 0 0;">${tierInfo.name} Plan Activated</p>
        </div>
        <div style="padding: 32px; background: #ffffff;">
          <p>Hi there,</p>
          <p>Your <strong>ShieldBuild ${tierInfo.name}</strong> subscription is now active. Here's what you have access to:</p>
          <ul style="line-height: 1.6;">
            ${tierInfo.features.split(', ').map(f => `<li>${f}</li>`).join('')}
          </ul>
          <p><strong>Next steps:</strong></p>
          <p>${tierInfo.nextSteps}</p>
          <div style="margin: 32px 0; padding: 20px; background: #f5f5f5; border-radius: 8px;">
            <p style="margin: 0;"><strong>Need help getting started?</strong></p>
            <p style="margin: 8px 0 0;">Reply to this email or contact us at <a href="mailto:safety@edgeiqlabs.com">safety@edgeiqlabs.com</a></p>
          </div>
          <p>Stay safe,<br>The EdgeIQ Labs Team</p>
        </div>
        <div style="padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p>EdgeIQ Labs | <a href="https://edgeiqlabs.com">edgeiqlabs.com</a></p>
        </div>
      </div>
    `;

    try {
      const resendResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'ShieldBuild <safety@edgeiqlabs.com>',
          to: [customerEmail],
          subject: `Welcome to ShieldBuild ${tierInfo.name} — Let's get you set up`,
          html: emailHtml
        })
      });

      if (!resendResponse.ok) {
        const errText = await resendResponse.text();
        console.error(`Resend API error: ${resendResponse.status} - ${errText}`);
      } else {
        console.log(`Welcome email sent to ${customerEmail} for ${productName} (${tier})`);
      }
    } catch (e) {
      console.error('Failed to send welcome email:', e);
    }
  }

  return new Response('OK', { status: 200 });
}
