#!/usr/bin/env node
/**
 * EdgeIQ Labs — Weekly Security Intelligence Newsletter
 *
 * Runs every Tuesday via Hermes cron. Generates a security intel issue
 * using Dialagram (qwen-3.8-max), then sends it to the Resend Audience.
 *
 * Required env vars:
 *   RESEND_API_KEY  — Resend API key (re_...)
 *   DIALAGRAM_API_KEY — Dialagram API key for content generation
 *
 * Usage: RESEND_API_KEY=... DIALAGRAM_API_KEY=... node scripts/weekly-newsletter.js
 */

const RESEND_API = 'https://api.resend.com';
const AUDIENCE_ID = 'e0b2c71a-0a3d-4a06-baa7-deabc88b1158';
const DIALAGRAM_URL = 'https://dialagram.me/router/v1/chat/completions';
const FROM = 'EdgeIQ Labs <security@edgeiqlabs.com>';

// Load env vars from .hermes/.env if not already set (for cron --no-agent mode)
try {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(process.env.HOME || '/home/guy', '.hermes', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch(_) {}

// Map Hermes key name to what we expect
if (!process.env.DIALAGRAM_API_KEY && process.env.HERMES_CUSTOM_DIALAGRAM_ME_API_KEY) {
  process.env.DIALAGRAM_API_KEY = process.env.HERMES_CUSTOM_DIALAGRAM_ME_API_KEY;
}

async function generateContent() {
  const prompt = `You are the EdgeIQ Labs Security Intelligence newsletter writer.
Generate this week's newsletter issue. Format as clean HTML (no doctype/head/body tags, just the inner content).

Structure:
1. A brief intro paragraph (2-3 sentences) about the current threat landscape this week
2. **Attack Technique Breakdown** — pick one real, recent CVE or attack technique from the past week. Explain what it is, who it affects, and how to mitigate it in 3-4 sentences. Use a specific CVE number if possible.
3. **Tool Release Spotlight** — highlight one new or updated open-source security tool. What it does, why it matters, link to its GitHub.
4. **Practical Guide** — one actionable security tip that small teams can implement in under 30 minutes (e.g., enabling MFA on a specific service, configuring a DNS record, hardening an SSH config).
5. A brief sign-off mentioning EdgeIQ Labs free scanners at https://edgeiqlabs.com/free-tools/

Style rules:
- Dark theme compatible (use inline styles with colors: #3dd9ff for accent, #e8eef7 for text, #9fb0c7 for muted)
- No fluff, no corporate speak. Direct and practical.
- Use <h2> for section headers with style="color:#3dd9ff;font-size:18px;font-weight:700;margin:24px 0 12px;"
- Use <p> with style="font-size:14px;color:#9fb0c7;line-height:1.7;margin:0 0 16px;"
- Use <a> with style="color:#3dd9ff;text-decoration:none;font-weight:600;"
- Keep total length under 600 words
- Include today's date in the intro`;

  const res = await fetch(DIALAGRAM_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DIALAGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen-3.8-max',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Dialagram failed: ${res.status} ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function wrapEmail(innerHTML) {
  const S = { bg: '#0b0f14', card: '#121923', border: '#1e2e3e', text: '#e8eef7', accent: '#3dd9ff' };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:Inter,system-ui,Arial,sans-serif;color:${S.text};">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 20px;">
    <span style="font-size:18px;font-weight:800;color:${S.text};">EdgeIQ<span style="color:${S.accent}"> Labs</span></span>
    <span style="font-size:12px;color:#5a6a7e;margin-left:12px;">Security Intelligence Weekly</span>
  </td></tr>
  <tr><td style="background:${S.card};border:1px solid ${S.border};border-radius:14px;padding:32px;">
    ${innerHTML}
  </td></tr>
  <tr><td style="padding:20px 0 0;text-align:center;">
    <p style="font-size:11px;color:#4a6080;line-height:1.6;margin:0;">
      EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a><br>
      You're receiving this because you subscribed to Security Intelligence.<br>
      <a href="mailto:security@edgeiqlabs.com?subject=Unsubscribe" style="color:#4a6080;">Unsubscribe</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function getSubscribers() {
  const res = await fetch(`${RESEND_API}/audiences/${AUDIENCE_ID}/contacts`, {
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch subscribers: ${res.status}`);
  const data = await res.json();
  return (data.data || []).filter(c => !c.unsubscribed).map(c => c.email);
}

async function sendBatch(emails, subject, html) {
  let sent = 0;
  let failed = 0;
  // Send in batches of 10 to avoid rate limits
  for (let i = 0; i < emails.length; i += 10) {
    const batch = emails.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(email =>
        fetch(`${RESEND_API}/emails`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from: FROM, to: [email], subject, html }),
        })
      )
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') sent++;
      else failed++;
    });
    // Rate limit pause between batches
    if (i + 10 < emails.length) await new Promise(res => setTimeout(res, 1000));
  }
  return { sent, failed };
}

async function main() {
  if (!process.env.RESEND_API_KEY) {
    console.error('Missing RESEND_API_KEY');
    process.exit(1);
  }
  if (!process.env.DIALAGRAM_API_KEY) {
    console.error('Missing DIALAGRAM_API_KEY');
    process.exit(1);
  }

  console.log('[1/4] Fetching subscribers...');
  const subscribers = await getSubscribers();
  console.log(`  Found ${subscribers.length} active subscribers`);

  if (subscribers.length === 0) {
    console.log('No subscribers. Skipping.');
    process.exit(0);
  }

  console.log('[2/4] Generating newsletter content via Dialagram...');
  const rawContent = await generateContent();
  console.log(`  Generated ${rawContent.length} chars of content`);

  console.log('[3/4] Wrapping email template...');
  const html = wrapEmail(rawContent);
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const subject = `Security Intelligence Weekly — ${today}`;

  console.log(`[4/4] Sending to ${subscribers.length} subscribers...`);
  const result = await sendBatch(subscribers, subject, html);
  console.log(`  Sent: ${result.sent}, Failed: ${result.failed}`);
  console.log('Done.');
}

main().catch(err => {
  console.error('Newsletter send failed:', err.message);
  process.exit(1);
});
