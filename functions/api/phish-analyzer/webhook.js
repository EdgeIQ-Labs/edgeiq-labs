// Phishing Analyzer webhook - Stripe subscription lifecycle
export async function onRequestPost(context) {
  const { request, env } = context;
  const sig = request.headers.get("stripe-signature");
  const secret = env.PHISH_ANALYZER_WEBHOOK_SECRET;
  
  if (!sig || !secret) {
    return new Response("Missing signature or secret", { status: 400 });
  }

  const body = await request.text();
  
  // Verify signature using crypto.subtle
  try {
    const parts = sig.split(",");
    const timestamp = parts.find(p => p.startsWith("t=")).replace("t=", "");
    const sigValue = parts.find(p => p.startsWith("v1=")).replace("v1=", "");
    
    const signedPayload = `${timestamp}.${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, "0")).join("");
    
    if (expected !== sigValue) {
      return new Response("Invalid signature", { status: 400 });
    }
  } catch (e) {
    return new Response("Signature verification failed: " + e.message, { status: 400 });
  }

  const event = JSON.parse(body);
  
  // Handle subscription lifecycle events
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    if (email) {
      try {
        await env.PHISH_DB.prepare(
          "INSERT OR REPLACE INTO subscribers (id, email, tier, stripe_customer_id, status, subscribed_at) VALUES (?, ?, 'pro', ?, 'active', datetime('now'))"
        ).bind(session.id, email, session.customer).run();
      } catch (e) { /* D1 might not be bound yet */ }
      
      // Welcome email via Resend
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "EdgeIQ Labs Support <support@edgeiqlabs.com>",
            to: email,
            subject: "Welcome to Phishing Analyzer Pro!",
            html: "<h2>Welcome to Phishing Analyzer Pro!</h2><p>Your subscription is active. You now have:</p><ul><li>Unlimited email analyses</li><li>Full forensic reports (all indicators, not just top 3)</li><li>Historical lookups</li><li>Bulk API access</li><li>DNS Firewall integration</li></ul><p>Analyze emails at <a href='https://edgeiqlabs.com/phish-analyzer/'>edgeiqlabs.com/phish-analyzer</a></p><p>— EdgeIQ Labs Support</p>"
          })
        });
      } catch (e) { /* non-fatal */ }
    }
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    try {
      await env.PHISH_DB.prepare(
        "UPDATE subscribers SET status = ? WHERE stripe_customer_id = ?"
      ).bind(sub.status, sub.customer).run();
    } catch (e) {}
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    try {
      await env.PHISH_DB.prepare(
        "UPDATE subscribers SET status = 'cancelled' WHERE stripe_customer_id = ?"
      ).bind(sub.customer).run();
    } catch (e) {}
  }

  return new Response("ok", { status: 200 });
}
