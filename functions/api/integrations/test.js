// POST /api/integrations/test
// Body: { email, domain }
// Fires a test payload to all registered webhooks for this email+domain

export async function onRequestPost({ request, env }) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

  if (!email || !domain) return json({ error: 'email and domain required' }, 400);

  const key = `webhooks:${email}:${domain}`;
  const raw = await env.PULSE_KV.get(key);
  if (!raw) return json({ error: 'No webhooks registered for this email + domain' }, 404);

  let record;
  try { record = JSON.parse(raw); } catch { return json({ error: 'Corrupt record' }, 500); }

  if (!record.webhooks || record.webhooks.length === 0) {
    return json({ error: 'No webhook destinations configured' }, 400);
  }

  const testPayload = {
    type: 'test',
    source: 'edgeiq',
    domain,
    severity: 'info',
    message: 'This is a test alert from EdgeIQ Integrations. Your webhook is wired up correctly.',
    timestamp: new Date().toISOString(),
    details: {
      tool: 'EdgeIQ Integrations',
      note: 'Test delivery — no action required',
    },
  };

  const slackPayload = {
    text: `*[EdgeIQ Test]* Webhook delivery confirmed for \`${domain}\` ✅`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*EdgeIQ Test Alert*\nYour webhook for \`${domain}\` is working correctly.\n\n_This is a test — no action needed._`,
        },
      },
    ],
  };

  const results = [];

  for (const wh of record.webhooks) {
    const isSlackOrTeams = wh.url.includes('hooks.slack.com') || wh.url.includes('webhook.office.com');
    const isDiscord = wh.url.includes('discord.com');

    let payload;
    if (isSlackOrTeams) {
      payload = slackPayload;
    } else if (isDiscord) {
      payload = { content: `**[EdgeIQ Test]** Webhook for \`${domain}\` is working ✅` };
    } else {
      payload = testPayload;
    }

    try {
      const res = await fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      results.push({ url: wh.url.substring(0, 40) + '...', type: wh.type, status: res.status, ok: res.ok });
    } catch (err) {
      results.push({ url: wh.url.substring(0, 40) + '...', type: wh.type, status: 0, ok: false, error: err.message });
    }
  }

  return json({ ok: true, results });
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
