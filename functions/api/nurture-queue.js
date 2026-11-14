/**
 * Email Nurture Sequence Queue Processor
 * Triggered by CF Pages cron every 6 hours
 * Sends 3-email drip: welcome → value tip → soft upsell
 */

const DRIP_SEQUENCE = [
  {
    delay_hours: 0,
    subject: 'Your security report is ready (+ a quick tip)',
    body: `Hey,

Thanks for using EdgeIQ Labs. Your scan results are ready — but here's something most people miss:

The #1 vulnerability we see across thousands of scans isn't outdated software or weak passwords. It's exposed configuration files that leak API keys, database credentials, and internal endpoints.

One quick fix: add a .gitignore rule for *.env, *.config, and credentials.json today. Takes 30 seconds, prevents the most common breach vector we see.

If you want to go deeper, our paid tools automate this detection across your entire infrastructure.

EdgeIQ Labs Support`
  },
  {
    delay_hours: 48,
    subject: '3 security wins you can implement today',
    body: `Hey,

Following up on your recent scan. Here are three high-impact fixes that take under 10 minutes each:

1. Rotate any API keys found in public repos immediately (even if they look inactive)
2. Enable branch protection on main/master branches to prevent force-pushes
3. Add SPF/DKIM records to your domain to stop email spoofing

These three changes alone would have prevented 70% of the breaches we investigated last quarter.

Want automated monitoring for these issues? Our DNS Firewall ($5/mo) and Phishing Analyzer Pro ($29/mo) catch them before attackers do.

→ https://edgeiqlabs.com/dnsfirewall/
→ https://edgeiqlabs.com/phish-analyzer/

EdgeIQ Labs Support`
  },
  {
    delay_hours: 120,
    subject: 'Last note: automate your security posture',
    body: `Hey,

Final note from us. You've got the manual fixes — now here's how to make them stick:

Our StatusPage ($9/mo) auto-detects when your services go down and notifies customers before they notice. DNS Firewall ($5/mo) pushes blocklist updates across your Pi-hole fleet every 15 minutes. Phishing Analyzer Pro ($29/mo) gives unlimited forensic analysis with historical tracking.

All three run on serverless infra, zero maintenance, cancel anytime.

As someone who already used our free tools, happy to offer 20% off your first month on any paid tier. Just reply to this email with which tool interests you.

Either way, stay safe out there.

EdgeIQ Labs Support`
  }
];

export async function onRequest(context) {
  const { env } = context;
  
  // Auth gate
  const authHeader = context.request.headers.get('X-Internal-Key');
  const validKey = env.NURTURE_INTERNAL_KEY || '3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
  if (authHeader !== validKey) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  try {
    // Get pending nurture entries from KV
    const pending = await env.PULSE_KV.get('nurture:pending', 'json') || [];
    const now = Date.now();
    const toSend = [];
    const remaining = [];
    
    for (const entry of pending) {
      const step = DRIP_SEQUENCE[entry.step];
      if (!step) {
        // Invalid step, skip
        continue;
      }
      
      const sendAt = entry.enqueued_at + (step.delay_hours * 3600 * 1000);
      if (now >= sendAt) {
        toSend.push({ ...entry, step_config: step });
      } else {
        remaining.push(entry);
      }
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const item of toSend) {
      try {
        const htmlBody = item.step_config.body.replace(/\n/g, '<br>');
        
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
            to: [item.email],
            subject: item.step_config.subject,
            html: htmlBody
          })
        });
        
        if (res.ok) {
          sent++;
          
          // Advance to next step or mark complete
          if (item.step < DRIP_SEQUENCE.length - 1) {
            remaining.push({
              email: item.email,
              step: item.step + 1,
              enqueued_at: item.enqueued_at,
              source: item.source
            });
          }
          // If last step, don't re-add — sequence complete
        } else {
          failed++;
          // Keep in queue for retry
          remaining.push(item);
        }
      } catch (e) {
        failed++;
        remaining.push(item);
      }
    }
    
    // Update KV with remaining items
    await env.PULSE_KV.put('nurture:pending', JSON.stringify(remaining));
    
    return new Response(JSON.stringify({
      processed: toSend.length,
      sent,
      failed,
      remaining: remaining.length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
