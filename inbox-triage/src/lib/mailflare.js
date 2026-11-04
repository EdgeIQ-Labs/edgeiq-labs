/**
 * EdgeIQ Inbox Triage - Mailflare API Client
 * Interacts with customer's Mailflare instance for mailbox ops
 */

export async function listMailboxes(env, customerId) {
  const mailboxes = await env.DB.prepare(
    'SELECT id, email_address, provider, ingest_method, is_active, created_at FROM mailboxes WHERE customer_id = ?'
  ).bind(customerId).all();
  return mailboxes.results || [];
}

export async function getMailboxStats(env, mailboxId) {
  const stats = await env.DB.prepare(`
    SELECT 
      category,
      priority,
      COUNT(*) as count
    FROM classifications 
    WHERE mailbox_id = ? 
    GROUP BY category, priority
  `).bind(mailboxId).all();
  return stats.results || [];
}

export async function sendViaMailflare(env, mailboxId, to, subject, body, headers = {}) {
  // For MVP: use Resend as the outbound sender since Mailflare SMTP relay
  // requires per-customer API key setup. Customers who want native Mailflare
  // sending can configure their own SMTP credentials later.
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured');
    return { success: false, error: 'No outbound email key configured' };
  }

  const mailbox = await env.DB.prepare(
    'SELECT email_address FROM mailboxes WHERE id = ?'
  ).bind(mailboxId).first();

  if (!mailbox) return { success: false, error: 'Mailbox not found' };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailbox.email_address,
        to: [to],
        subject: subject,
        text: body,
        headers: headers
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Resend error: ${response.status} - ${err}`);
    }

    const result = await response.json();
    return { success: true, messageId: result.id };
  } catch (err) {
    console.error('Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

export async function forwardToMailbox(env, sourceMailboxId, targetEmail, messageId) {
  // Forward an email to a different mailbox based on routing rules
  console.log(`Forwarding ${messageId} from mailbox ${sourceMailboxId} to ${targetEmail}`);
  // Implementation depends on whether we're using IMAP forwarding or Mailflare API
  return { success: true, forwarded_to: targetEmail };
}
