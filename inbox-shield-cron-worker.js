/**
 * EdgeIQ Inbox Shield — Weekly Email Security Cron Worker
 * Deploy as: edgeiq-inbox-shield-cron
 * Cron: "0 8 * * 1" (every Monday at 08:00 UTC)
 */

const SCANNER_URL = 'https://edgeiq-inbox-shield.gpalmieri21.workers.dev';

async function runShieldScan(domain) {
  try {
    const resp = await fetch(SCANNER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function detectChanges(prev, curr) {
  if (!prev) return [{ type: 'first_scan', message: 'First scan completed.' }];
  const changes = [];

  const checks = ['spf', 'dmarc', 'dkim', 'mx'];
  for (const check of checks) {
    const pc = prev.checks?.[check];
    const cc = curr.checks?.[check];
    if (!pc || !cc) continue;
    if (pc.grade !== cc.grade) {
      changes.push({ check, type: 'grade', prev: pc.grade, curr: cc.grade });
    }
    if (pc.present !== cc.present) {
      changes.push({ check, type: 'presence', prev: pc.present ? 'present' : 'missing', curr: cc.present ? 'present' : 'missing' });
    }
  }
  if (prev.grade !== curr.grade) {
    changes.push({ check: 'overall', type: 'grade', prev: prev.grade, curr: curr.grade });
  }
  return changes;
}

const GRADE_COLOR = { A: '#3de19e', B: '#70f0a8', C: '#ffb347', D: '#ff8c42', F: '#ff6b6b' };
const GRADE_BG = { A: '#0d1f17', B: '#0d1f17', C: '#1f1500', D: '#1f0e00', F: '#1f0000' };

function gradeBar(grade) {
  const color = GRADE_COLOR[grade] || '#9fb0c7';
  return `<span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;background:${GRADE_BG[grade] || '#121923'};border:2px solid ${color};border-radius:8px;font-size:18px;font-weight:900;color:${color};">${grade}</span>`;
}

function checkRow(name, checkData, label) {
  const grade = checkData?.grade || 'F';
  const color = GRADE_COLOR[grade] || '#9fb0c7';
  const present = checkData?.present;
  const record = checkData?.record || checkData?.selectors?.join(', ') || '';
  return `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:14px;color:#e8eef7;font-weight:600;">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;text-align:center;">${gradeBar(grade)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:12px;color:#9fb0c7;word-break:break-all;">${present ? (record || '✓ configured') : '✗ not found'}</td>
    </tr>`;
}

function buildEmailHtml(domain, result, changes, plan, siteUrl) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const grade = result.grade;
  const gradeColor = GRADE_COLOR[grade] || '#9fb0c7';
  const hasChanges = changes.length > 0 && !(changes.length === 1 && changes[0].type === 'first_scan');

  const criticalFindings = (result.findings || []).filter(f => f.severity === 'critical' || f.severity === 'high');
  const topFindings = criticalFindings.slice(0, 4);

  const findingsHtml = topFindings.length === 0
    ? '<p style="color:#3de19e;font-size:13px;margin:0;">No critical or high findings — excellent posture.</p>'
    : topFindings.map(f => `
      <div style="background:#121923;border-left:3px solid ${f.severity === 'critical' ? '#ff6b6b' : '#ffb347'};border-radius:4px;padding:10px 14px;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:700;color:${f.severity === 'critical' ? '#ff6b6b' : '#ffb347'};text-transform:uppercase;margin-bottom:4px;">${f.severity} · ${f.type.replace(/_/g,' ')}</div>
        <div style="font-size:13px;color:#c8d8e8;">${f.message}</div>
      </div>`).join('');

  const changesHtml = !hasChanges
    ? '<p style="color:#9fb0c7;font-size:13px;margin:0;">No changes detected since last scan.</p>'
    : changes.filter(c => c.type !== 'first_scan').map(c => `
      <div style="background:#121923;border:1px solid #1e2e3e;border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:13px;">
        <strong style="color:#e8eef7;text-transform:uppercase;">${c.check}</strong> — ${c.type === 'grade' ? `grade changed <span style="color:#9fb0c7;">${c.prev}</span> → <span style="color:${GRADE_COLOR[c.curr] || '#fff'};">${c.curr}</span>` : `${c.prev} → ${c.curr}`}
      </div>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>EdgeIQ Inbox Shield — ${domain}</title></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 20px;">
    <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(61,225,158,0.12);border:1px solid rgba(61,225,158,0.35);color:#3de19e;font-size:11px;font-weight:700;padding:4px 12px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      ✉ INBOX SHIELD WEEKLY REPORT
    </div>
    <h1 style="color:#e8eef7;font-size:24px;font-weight:800;margin:0 0 8px;">${domain}</h1>
    <p style="color:#9fb0c7;font-size:13px;margin:0 0 16px;">${date} · ${plan === 'pro' ? 'Pro' : 'Free'} plan</p>
    <!-- Overall grade -->
    <div style="display:inline-block;background:${GRADE_BG[grade] || '#121923'};border:2px solid ${gradeColor};border-radius:16px;padding:12px 32px;">
      <div style="font-size:11px;font-weight:700;color:#9fb0c7;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Email Security Grade</div>
      <div style="font-size:52px;font-weight:900;color:${gradeColor};line-height:1;">${grade}</div>
    </div>
  </div>

  <!-- Summary -->
  <p style="color:#c8d8e8;font-size:14px;text-align:center;margin:0 0 20px;">${result.summary || ''}</p>

  <!-- Check grades -->
  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:12px;overflow:hidden;margin-bottom:18px;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e2e3e;font-size:12px;font-weight:700;color:#9fb0c7;text-transform:uppercase;letter-spacing:.05em;">Individual Check Grades</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr style="background:#0d141c;">
        <th style="padding:8px 14px;text-align:left;font-size:11px;color:#9fb0c7;font-weight:600;">Check</th>
        <th style="padding:8px 14px;text-align:center;font-size:11px;color:#9fb0c7;font-weight:600;">Grade</th>
        <th style="padding:8px 14px;text-align:left;font-size:11px;color:#9fb0c7;font-weight:600;">Record / Status</th>
      </tr>
      ${checkRow('spf', result.checks?.spf, 'SPF')}
      ${checkRow('dmarc', result.checks?.dmarc, 'DMARC')}
      ${checkRow('dkim', result.checks?.dkim, 'DKIM')}
      ${checkRow('mx', result.checks?.mx, 'MX')}
    </table>
  </div>

  <!-- Top Findings -->
  <div style="background:#0b0f14;border:1px solid #1e2e3e;border-radius:12px;padding:18px;margin-bottom:18px;">
    <h2 style="color:#e8eef7;font-size:14px;font-weight:700;margin:0 0 12px;">Top Findings</h2>
    ${findingsHtml}
    ${criticalFindings.length > 4 ? `<p style="color:#9fb0c7;font-size:12px;margin:8px 0 0;">+${criticalFindings.length - 4} more findings — <a href="${siteUrl}/inbox-shield/" style="color:#3dd9ff;">view full report</a></p>` : ''}
  </div>

  <!-- Changes -->
  <div style="background:#0b0f14;border:1px solid ${hasChanges ? 'rgba(255,179,71,0.4)' : '#1e2e3e'};border-radius:12px;padding:18px;margin-bottom:18px;">
    <h2 style="color:${hasChanges ? '#ffb347' : '#e8eef7'};font-size:14px;font-weight:700;margin:0 0 12px;">
      ${hasChanges ? `⚠️ Changes since last scan` : '✅ No changes since last scan'}
    </h2>
    ${changesHtml}
  </div>

  ${plan === 'free' ? `
  <!-- Upsell -->
  <div style="background:linear-gradient(135deg,#0d1f17,#071018);border:1px solid rgba(61,225,158,0.3);border-radius:12px;padding:20px;text-align:center;margin-bottom:18px;">
    <h3 style="color:#3de19e;font-size:15px;font-weight:700;margin:0 0 8px;">Upgrade to Inbox Shield Pro — $15/mo</h3>
    <p style="color:#9fb0c7;font-size:13px;margin:0 0 14px;">Get daily monitoring, DKIM key rotation alerts, remediation guides, and priority support.</p>
    <a href="${siteUrl}/inbox-shield/#pricing" style="display:inline-block;background:#3de19e;color:#071018;font-weight:700;font-size:14px;padding:10px 24px;border-radius:8px;text-decoration:none;">Upgrade now →</a>
  </div>` : ''}

  <!-- CTA -->
  <div style="text-align:center;padding:16px 0;">
    <a href="${siteUrl}/inbox-shield/" style="display:inline-block;background:transparent;border:1px solid #3de19e;color:#3de19e;font-weight:700;font-size:14px;padding:10px 24px;border-radius:8px;text-decoration:none;">
      Run a new scan →
    </a>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1e2e3e;padding:20px 0;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 4px;">EdgeIQ Inbox Shield · <a href="${siteUrl}" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
    <p style="margin:0;">Monitoring ${domain} for email security issues.</p>
    <p style="margin:6px 0 0;"><a href="mailto:support@edgeiqlabs.com?subject=Unsubscribe Shield ${domain}" style="color:#9fb0c7;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
}

async function sendShieldDigest(env, subscriber, result, changes) {
  const { email, domain, plan } = subscriber;
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const fromEmail = env.FROM_EMAIL || 'alerts@edgeiqlabs.com';
  const hasChanges = changes.some(c => c.type !== 'first_scan');

  const subject = hasChanges
    ? `⚠️ Inbox Shield — email security changes on ${domain} (grade: ${result.grade})`
    : `✅ Inbox Shield — weekly report for ${domain} (grade: ${result.grade})`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `EdgeIQ Inbox Shield <${fromEmail}>`,
      to: [email],
      subject,
      html: buildEmailHtml(domain, result, changes, plan, siteUrl),
    }),
  });

  if (!resp.ok) {
    console.error(`Email failed for ${email}: ${await resp.text()}`);
    return false;
  }
  return true;
}

async function deliverWebhooks(env, email, domain, payload) {
  const key = `webhooks:${email}:${domain}`;
  const raw = await env.PULSE_KV.get(key).catch(() => null);
  if (!raw) return;
  let record;
  try { record = JSON.parse(raw); } catch { return; }
  if (!record.webhooks?.length) return;

  const isSlackOrTeams = url => url.includes('hooks.slack.com') || url.includes('webhook.office.com');
  const isDiscord = url => url.includes('discord.com');

  const status = payload.changes_count > 0 ? '⚠️' : '✅';
  const slackBody = {
    text: `${status} EdgeIQ Inbox Shield digest for ${domain}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*[EdgeIQ Inbox Shield]* ${status} *${domain}*\n${payload.message}` } },
    ],
  };

  for (const wh of record.webhooks) {
    let body;
    if (isSlackOrTeams(wh.url)) {
      body = slackBody;
    } else if (isDiscord(wh.url)) {
      body = { content: `**[EdgeIQ Inbox Shield]** ${status} **${domain}**: ${payload.message}` };
    } else {
      body = payload;
    }
    try {
      await fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {}
  }
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.PULSE_KV || !env.RESEND_API_KEY) {
      console.error('Missing PULSE_KV or RESEND_API_KEY');
      return;
    }

    console.log('Inbox Shield cron started:', new Date().toISOString());

    const list = await env.PULSE_KV.list({ prefix: 'shield:' });
    console.log(`Processing ${list.keys.length} Inbox Shield subscriber(s)`);

    for (const key of list.keys) {
      let subscriber;
      try {
        const raw = await env.PULSE_KV.get(key.name);
        if (!raw) continue;
        subscriber = JSON.parse(raw);
      } catch { continue; }

      if (!subscriber.active) continue;

      const result = await runShieldScan(subscriber.domain);
      if (!result) {
        console.error(`Scan failed for ${subscriber.domain}`);
        continue;
      }

      const changes = detectChanges(subscriber.last_findings, result);

      try {
        await sendShieldDigest(env, subscriber, result, changes);
      } catch (err) {
        console.error(`Email error for ${subscriber.email}:`, err.message);
      }

      await deliverWebhooks(env, subscriber.email, subscriber.domain, {
        type: 'inbox_shield_digest', source: 'edgeiq', domain: subscriber.domain,
        severity: changes.length > 0 ? 'warning' : 'info',
        message: changes.length > 0
          ? `${changes.length} email security change${changes.length > 1 ? 's' : ''} detected on ${subscriber.domain}.`
          : `Weekly Inbox Shield scan complete for ${subscriber.domain} — no changes detected.`,
        timestamp: new Date().toISOString(),
        changes_count: changes.length,
        details: { grade: result.grade, checks: result.checks, changes, plan: subscriber.plan },
      });

      const updated = { ...subscriber, last_scan: new Date().toISOString(), last_findings: result };
      try {
        await env.PULSE_KV.put(key.name, JSON.stringify(updated), {
          metadata: { email: subscriber.email, domain: subscriber.domain, plan: subscriber.plan, product: 'inbox-shield', last_scan: updated.last_scan },
        });
      } catch (err) {
        console.error(`KV update failed for ${subscriber.email}:`, err.message);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    console.log('Inbox Shield cron complete:', new Date().toISOString());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger' && url.searchParams.get('secret') === env.TRIGGER_SECRET) {
      await this.scheduled({}, env, {});
      return new Response('Inbox Shield cron triggered.', { status: 200 });
    }
    return new Response('EdgeIQ Inbox Shield Cron Worker', { status: 200 });
  },
};
