// Verify Pro subscription after checkout redirect
// Accepts session_id from Stripe success URL, looks up customer email, checks D1/KV

export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const sessionId = (body.session_id || '').trim();
    
    if (!sessionId) {
      return new Response(JSON.stringify({ is_pro: false }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Look up the Stripe checkout session to get customer email
    let customerEmail = null;
    try {
      const sessRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
      });
      if (sessRes.ok) {
        const sess = await sessRes.json();
        customerEmail = sess.customer_details?.email || sess.customer_email || null;
      }
    } catch (e) { /* Stripe lookup failed, fall through */ }
    
    if (!customerEmail) {
      return new Response(JSON.stringify({ is_pro: false }), { 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // Check D1 for active Pro subscription
    let isPro = false;
    try {
      const sub = await env.PHISH_DB.prepare(
        "SELECT email, tier, status FROM subscribers WHERE email = ? AND status = 'active' AND tier = 'pro'"
      ).bind(customerEmail).first();
      if (sub) isPro = true;
    } catch (e) { /* D1 not bound */ }
    
    // Fallback: check KV
    if (!isPro) {
      const kvKey = await env.PULSE_KV.get(`phish-pro:${customerEmail}`);
      if (kvKey) isPro = true;
    }
    
    // If verified, store pro key in KV for future use and return it
    if (isPro) {
      const proKey = customerEmail;
      await env.PULSE_KV.put(`phish-pro:${customerEmail}`, 'active', { expirationTtl: 2592000 });
      return new Response(JSON.stringify({ is_pro: true, pro_key: proKey }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ is_pro: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (e) {
    return new Response(JSON.stringify({ is_pro: false, error: e.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}
