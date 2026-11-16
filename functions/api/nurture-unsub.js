/**
 * Nurture Sequence Unsubscribe
 * GET  /api/nurture-unsub?email=user@example.com  → confirmation page
 * POST /api/nurture-unsub?email=user@example.com  → RFC 8058 one-click (mail clients)
 *
 * Writes a durable suppression record (`nurture:unsub:<email>`) AND flags any
 * queued entries, so a later re-capture cannot resurrect the sequence.
 */

const AUDIENCE_ID = 'e0b2c71a-0a3d-4a06-baa7-deabc88b1158';

function page(title, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title></head>
<body style="margin:0;padding:40px 20px;background:#0b0f14;font-family:Inter,system-ui,Arial,sans-serif;color:#e8eef7;text-align:center;">
  <div style="max-width:480px;margin:0 auto;">
    <div style="font-size:18px;font-weight:800;margin-bottom:28px;">EdgeIQ<span style="color:#3dd9ff;"> Labs</span></div>
    <h1 style="font-size:24px;font-weight:800;margin:0 0 16px;">${title}</h1>
    <p style="font-size:15px;color:#9fb0c7;line-height:1.6;margin:0 0 24px;">${message}</p>
    <a href="https://edgeiqlabs.com/free-tools/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;font-size:14px;padding:12px 24px;border-radius:9px;text-decoration:none;">Browse free tools →</a>
  </div>
</body></html>`;
}

async function suppress(env, email) {
  // Durable suppression record — checked at enrollment time.
  await env.PULSE_KV.put(
    `nurture:unsub:${email}`,
    JSON.stringify({ email, unsubscribedAt: Date.now() })
  );

  // Flag anything currently queued (keep the entry as a tombstone).
  const pending = await env.PULSE_KV.get('nurture:pending', 'json').catch(() => null) || [];
  let touched = 0;
  const updated = pending.map(entry => {
    if (entry.email === email && !entry.unsubscribed) {
      touched++;
      return { ...entry, unsubscribed: true, unsubscribedAt: Date.now() };
    }
    return entry;
  });
  if (touched > 0) {
    await env.PULSE_KV.put('nurture:pending', JSON.stringify(updated));
  }

  // Best-effort: mark unsubscribed in the Resend audience too.
  if (env.RESEND_API_KEY) {
    try {
      await fetch(`https://api.resend.com/audiences/${AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ unsubscribed: true }),
      });
    } catch (_) {}
  }

  return touched;
}

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  const url = new URL(request.url);
  let email = (url.searchParams.get('email') || '').trim().toLowerCase();

  // One-click POST bodies may carry the address instead of the query string.
  if (!email && request.method === 'POST') {
    try {
      const text = await request.text();
      if (text.trim().startsWith('{')) {
        email = (JSON.parse(text).email || '').trim().toLowerCase();
      } else {
        email = (new URLSearchParams(text).get('email') || '').trim().toLowerCase();
      }
    } catch (_) {}
  }

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(page('Missing email address', 'That unsubscribe link looks incomplete. Reply to any EdgeIQ email and we will take care of it.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  try {
    await suppress(env, email);

    if (request.method === 'POST') {
      return Response.json({ ok: true, unsubscribed: email });
    }

    return new Response(page(
      "You're unsubscribed",
      'No more follow-up emails from EdgeIQ Labs. Your free tools still work, and you can sign up again any time.'
    ), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (e) {
    return new Response(page('Something went wrong', 'We could not process that just now. Reply to any EdgeIQ email and we will remove you manually.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}
