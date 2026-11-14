/**
 * Lead Capture Endpoint
 * Stores emails in KV and enqueues nurture drip sequence
 */
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await context.request.json();
    const email = body.email?.trim()?.toLowerCase();
    const source = body.source || 'unknown';

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Valid email required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { env } = context;

    // Store in KV leads list (deduplicated)
    const existingLeads = await env.PULSE_KV.get('leads:all', 'json') || [];
    const alreadyExists = existingLeads.some(l => l.email === email);

    if (!alreadyExists) {
      existingLeads.push({
        email,
        source,
        captured_at: Date.now()
      });
      await env.PULSE_KV.put('leads:all', JSON.stringify(existingLeads));

      // Enqueue into nurture drip sequence
      const pending = await env.PULSE_KV.get('nurture:pending', 'json') || [];
      pending.push({
        email,
        step: 0,
        enqueued_at: Date.now(),
        source
      });
      await env.PULSE_KV.put('nurture:pending', JSON.stringify(pending));

      // Send immediate welcome email with the free checklist/guide
      const welcomeBody = `Hey,\n\nThanks for grabbing our security resource from EdgeIQ Labs. Here's what you need to know:\n\nThe #1 vulnerability we see across thousands of scans isn't outdated software or weak passwords — it's exposed configuration files that leak API keys, database credentials, and internal endpoints.\n\nQuick wins you can do today:\n1. Add .env, *.config, and credentials.json to your .gitignore\n2. Rotate any API keys found in public repos immediately\n3. Enable branch protection on main/master branches\n\nIf you want automated monitoring for these issues, our tools handle it at scale:\n→ DNS Firewall ($5/mo): https://edgeiqlabs.com/dnsfirewall/\n→ Phishing Analyzer Pro ($29/mo): https://edgeiqlabs.com/phish-analyzer/\n→ StatusPage ($9/mo): https://edgeiqlabs.com/statuspage/\n\nStay safe out there.\n\nEdgeIQ Labs Support`;

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'EdgeIQ Labs <support@edgeiqlabs.com>',
          to: [email],
          subject: 'Your security checklist from EdgeIQ Labs',
          html: welcomeBody.replace(/\n/g, '<br>')
        })
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
