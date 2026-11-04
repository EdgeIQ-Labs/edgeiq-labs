/**
 * Send transactional emails via Resend
 */
const FROM_ADDRESSES = {
  default: 'EdgeIQ Labs <noreply@edgeiqlabs.com>',
  security: 'EdgeIQ Security <security@edgeiqlabs.com>',
  billing: 'EdgeIQ Billing <billing@edgeiqlabs.com>',
};

export async function sendEmail(apiKey, { to, subject, html, from }) {
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from || FROM_ADDRESSES.default,
      to: [to],
      subject,
      html,
    }),
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend error: ${err}`);
  }
  
  return resp.json();
}

// Welcome email template
export function welcomeEmailTemplate({ serviceName, customerName, dashboardUrl, apiKey }) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; padding: 40px; margin: 0; }
  .container { max-width: 600px; margin: 0 auto; background: #12121a; border-radius: 12px; padding: 40px; border: 1px solid #1e1e2e; }
  h1 { color: #3dd9ff; margin-top: 0; font-size: 24px; }
  .btn { display: inline-block; background: #3dd9ff; color: #0a0a0f; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 20px 0; }
  .key-box { background: #0a0a0f; border: 1px solid #1e1e2e; border-radius: 8px; padding: 16px; font-family: monospace; word-break: break-all; color: #00ff66; margin: 16px 0; }
  .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #1e1e2e; font-size: 12px; color: #666; }
</style></head>
<body>
<div class="container">
  <h1>Welcome to ${serviceName}!</h1>
  <p>Hi ${customerName || 'there'},</p>
  <p>Your account is active and ready to go. Here's everything you need:</p>
  
  <p><strong>Your Dashboard:</strong></p>
  <a href="${dashboardUrl}" class="btn">Open Dashboard →</a>
  
  <p><strong>Your API Key (save this!):</strong></p>
  <div class="key-box">${apiKey}</div>
  
  <p>Use this key to log into your dashboard and access the API.</p>
  
  <p>If you have any questions, reply to this email or reach out at support@edgeiqlabs.com.</p>
  
  <div class="footer">
    <p>EdgeIQ Labs · Secure compliance automation<br>
    This is an automated message. Your subscription is managed by Stripe.</p>
  </div>
</div>
</body>
</html>`;
}
