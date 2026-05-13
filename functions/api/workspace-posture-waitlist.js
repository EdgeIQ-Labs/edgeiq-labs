// POST /api/workspace-posture-waitlist
// Body: { email, domain, platform }
// Saves waitlist signup to PULSE_KV under key `waitlist:workspace-posture:{email}`

export async function onRequestPost({ request, env }) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const platform = (body.platform || 'unknown').trim().toLowerCase();

  if (!email || !email.includes('@')) return json({ error: 'Valid email required' }, 400);

  const validPlatforms = ['m365', 'google', 'both', 'unknown'];
  const safePlatform = validPlatforms.includes(platform) ? platform : 'unknown';

  const key = `waitlist:workspace-posture:${email}`;
  const existing = await env.PULSE_KV.get(key);
  if (existing) return json({ ok: true, already: true });

  const record = {
    email,
    domain: domain || null,
    platform: safePlatform,
    signed_up_at: new Date().toISOString(),
    source: 'workspace-posture-landing',
  };

  await env.PULSE_KV.put(key, JSON.stringify(record), {
    metadata: { email, platform: safePlatform, signed_up_at: record.signed_up_at },
  });

  // Send notification email to site owner
  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'EdgeIQ Waitlist <alerts@edgeiqlabs.com>',
        to: ['gpalmieri21@gmail.com'],
        subject: `New waitlist signup: Workspace Posture — ${email}`,
        html: `<p><strong>${email}</strong> joined the Workspace Posture waitlist.</p>
               <p>Platform: <strong>${safePlatform}</strong>${domain ? `<br>Domain: <strong>${domain}</strong>` : ''}</p>
               <p>Time: ${record.signed_up_at}</p>`,
      }),
    }).catch(() => {});
  }

  return json({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
