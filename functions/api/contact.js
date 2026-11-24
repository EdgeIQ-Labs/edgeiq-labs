/**
 * EdgeIQ contact form
 * POST /api/contact
 *
 * Validates a contact enquiry and delivers it to support via Resend.
 * No credential fallbacks: RESEND_API_KEY must be configured in Pages.
 */

const TOPICS = {
  smb: 'SMB monitoring',
  tool: 'Free tool',
  msp: 'MSP offering',
  account: 'Existing account',
  billing: 'Billing',
  compliance: 'Compliance',
  other: 'General'
};

function esc(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await context.request.json();

    // Honeypot: silent success for bots.
    if (body.website && String(body.website).trim()) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const company = String(body.company || '').trim();
    const domain = String(body.domain || '').trim();
    const message = String(body.message || '').trim();
    const topic = TOPICS[body.topic] ? body.topic : 'other';

    if (!name || name.length > 120) {
      return jsonError('Enter your name.', 400);
    }
    if (!email || !email.includes('@') || email.length > 254) {
      return jsonError('Enter a valid email address.', 400);
    }
    if (message.length < 10 || message.length > 5000) {
      return jsonError('Message must be between 10 and 5000 characters.', 400);
    }

    const apiKey = context.env && context.env.RESEND_API_KEY;
    if (!apiKey) {
      return jsonError('Email delivery is not configured.', 503);
    }

    const subject = `[Contact: ${TOPICS[topic]}] ${name}${company ? ' — ' + company : ''}`;
    const text = [
      `Topic: ${TOPICS[topic]}`,
      `Name: ${name}`,
      `Email: ${email}`,
      `Company: ${company || '-'}`,
      `Domain: ${domain || '-'}`,
      '',
      message
    ].join('\n');

    const html = `<div style="font-family:Inter,system-ui,Arial,sans-serif;line-height:1.6;color:#e8eef7;">
      <p><strong>New EdgeIQ Labs contact enquiry</strong></p>
      <p><strong>Topic:</strong> ${esc(TOPICS[topic])}<br>
      <strong>Name:</strong> ${esc(name)}<br>
      <strong>Email:</strong> ${esc(email)}<br>
      <strong>Company:</strong> ${esc(company) || '-'}<br>
      <strong>Domain:</strong> ${esc(domain) || '-'}</p>
      <div style="background:#111720;border:1px solid #1e2a38;border-radius:10px;padding:16px;white-space:pre-wrap;">${esc(message)}</div>
      <p style="font-size:12px;color:#64748b;">Reply directly to the sender using the reply-to header.</p>
    </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
        to: ['support@edgeiqlabs.com'],
        reply_to: email,
        subject,
        text,
        html
      })
    });

    if (!res.ok) {
      return jsonError('Could not deliver your message. Email support@edgeiqlabs.com directly.', 502);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return jsonError('Invalid request.', 400);
  }
}

function jsonError(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
