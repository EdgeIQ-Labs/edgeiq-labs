/**
 * EdgeIQ Vendor Watch — Alert Cron Worker
 * Deploy as: edgeiq-vendor-watch-cron
 * Cron: every 15 minutes
 *
 * Reads all vendor:* KV keys, fetches current vendor statuses,
 * diffs against last_statuses, and sends email alerts on change.
 * All-clear emails sent to Pro subscribers when vendors recover.
 */

const VENDOR_WATCH_API = 'https://edgeiqlabs.com/api/vendor-watch';

const STATUS_COLOR = {
  operational: '#3de19e',
  degraded:    '#ffb347',
  outage:      '#ff6b6b',
  unknown:     '#9fb0c7',
};
const STATUS_LABEL = {
  operational: '✅ Operational',
  degraded:    '⚠️ Degraded',
  outage:      '🔴 Outage',
  unknown:     '❓ Unknown',
};
const STATUS_BG = {
  operational: '#0d1f17',
  degraded:    '#1f1500',
  outage:      '#1f0000',
  unknown:     '#121923',
};

async function fetchVendorStatuses(env) {
  try {
    // Bypass edge cache by adding a cache-bust so we always get fresh data
    const url = `${VENDOR_WATCH_API}?cron=${Date.now()}`;
    const resp = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Build a map of id → { status, description, name, emoji, category }
    const map = {};
    for (const v of (data.vendors || [])) {
      map[v.id] = v;
    }
    return map;
  } catch {
    return null;
  }
}

function detectChanges(watchedVendorIds, lastStatuses, currentMap) {
  const newOutages = [];
  const recovered  = [];

  for (const id of watchedVendorIds) {
    const current = currentMap[id];
    if (!current) continue;
    const prevStatus = lastStatuses?.[id] || 'unknown';
    const currStatus = current.status;

    if (prevStatus === currStatus) continue;

    if (currStatus === 'degraded' || currStatus === 'outage') {
      newOutages.push({ ...current, prevStatus });
    } else if (currStatus === 'operational' && (prevStatus === 'degraded' || prevStatus === 'outage')) {
      recovered.push({ ...current, prevStatus });
    }
  }

  return { newOutages, recovered };
}

function buildCurrentStatuses(watchedVendorIds, currentMap) {
  const statuses = {};
  for (const id of watchedVendorIds) {
    if (currentMap[id]) statuses[id] = currentMap[id].status;
  }
  return statuses;
}

function vendorRow(v) {
  const color = STATUS_COLOR[v.status] || STATUS_COLOR.unknown;
  const bg    = STATUS_BG[v.status]    || STATUS_BG.unknown;
  return `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:14px;color:#e8eef7;">
        <span style="font-size:16px;margin-right:6px;">${v.emoji || '📦'}</span>
        <strong>${v.name}</strong>
        <span style="font-size:11px;color:#9fb0c7;margin-left:6px;">${v.category || ''}</span>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;text-align:right;">
        <span style="display:inline-block;background:${bg};border:1px solid ${color};color:${color};font-size:11px;font-weight:700;padding:3px 10px;border-radius:6px;">${STATUS_LABEL[v.status] || v.status}</span>
      </td>
    </tr>`;
}

function buildOutageEmail({ email, plan, affectedVendors, siteUrl }) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  const vendorNames = affectedVendors.map(v => v.name).join(', ');
  const isMultiple = affectedVendors.length > 1;
  const subject = affectedVendors.length === 1
    ? `🔴 ${affectedVendors[0].name} is ${affectedVendors[0].status} — EdgeIQ Vendor Watch`
    : `🔴 ${affectedVendors.length} vendors reporting issues — EdgeIQ Vendor Watch`;

  const vendorRows = affectedVendors.map(v => vendorRow(v)).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="text-align:center;padding:28px 0 20px;">
    <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,107,107,0.12);border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;font-size:11px;font-weight:700;padding:4px 14px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      📡 VENDOR WATCH ALERT
    </div>
    <h1 style="color:#e8eef7;font-size:22px;font-weight:800;margin:0 0 8px;line-height:1.2;">
      ${isMultiple ? `${affectedVendors.length} vendors in your stack are down` : `${affectedVendors[0].name} is reporting an issue`}
    </h1>
    <p style="color:#9fb0c7;font-size:13px;margin:0;">${date}</p>
  </div>

  <!-- Affected vendors -->
  <div style="background:#121923;border:1px solid rgba(255,107,107,0.3);border-radius:12px;overflow:hidden;margin-bottom:18px;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e2e3e;background:#1a0c0c;font-size:12px;font-weight:700;color:#ff9090;text-transform:uppercase;letter-spacing:.05em;">
      ⚠️ Affected Vendors
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${vendorRows}
    </table>
  </div>

  <!-- Description -->
  ${affectedVendors.map(v => `
  <div style="background:#0b0f14;border:1px solid #1e2e3e;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
    <div style="font-size:12px;font-weight:700;color:#9fb0c7;margin-bottom:4px;">${v.emoji} ${v.name}</div>
    <div style="font-size:13px;color:#c8d8e8;">${v.description || 'Status page reporting ' + v.status}</div>
  </div>`).join('')}

  <!-- Check live status -->
  <div style="text-align:center;padding:20px 0;">
    <a href="${siteUrl}/vendor-watch/" style="display:inline-block;background:#ff9f43;color:#1a0a00;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px;text-decoration:none;">
      View Live Status Dashboard →
    </a>
  </div>

  ${plan === 'free' ? `
  <!-- Upsell -->
  <div style="background:linear-gradient(135deg,#1a1200,#0b0f14);border:1px solid rgba(255,159,67,0.3);border-radius:12px;padding:18px;text-align:center;margin-bottom:18px;">
    <h3 style="color:#ff9f43;font-size:14px;font-weight:700;margin:0 0 6px;">Get All-Clear Alerts with Pro</h3>
    <p style="color:#9fb0c7;font-size:13px;margin:0 0 12px;">Free plan alerts on outages only. Upgrade to Pro to also get notified when ${affectedVendors.length === 1 ? affectedVendors[0].name : 'these vendors'} recover — so you know it's safe to resume.</p>
    <a href="${siteUrl}/vendor-watch/#pricing" style="display:inline-block;background:#ff9f43;color:#1a0a00;font-weight:700;font-size:13px;padding:9px 20px;border-radius:8px;text-decoration:none;">Upgrade to Pro — $9/mo →</a>
  </div>` : ''}

  <!-- Footer -->
  <div style="border-top:1px solid #1e2e3e;padding:18px 0;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 4px;">EdgeIQ Vendor Watch · <a href="${siteUrl}" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
    <p style="margin:0;">You're watching: ${vendorNames}</p>
    <p style="margin:6px 0 0;"><a href="mailto:alerts@edgeiqlabs.com?subject=Unsubscribe Vendor Watch ${email}" style="color:#9fb0c7;">Unsubscribe</a></p>
  </div>

</div>
</body>
</html>`;

  return { subject, html };
}

function buildAllClearEmail({ email, plan, recoveredVendors, siteUrl }) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  const vendorNames = recoveredVendors.map(v => v.name).join(', ');
  const subject = recoveredVendors.length === 1
    ? `✅ ${recoveredVendors[0].name} is back to normal — EdgeIQ Vendor Watch`
    : `✅ ${recoveredVendors.length} vendors recovered — EdgeIQ Vendor Watch`;

  const vendorRows = recoveredVendors.map(v => vendorRow(v)).join('');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="text-align:center;padding:28px 0 20px;">
    <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(61,225,158,0.12);border:1px solid rgba(61,225,158,0.35);color:#3de19e;font-size:11px;font-weight:700;padding:4px 14px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      📡 VENDOR WATCH — ALL CLEAR
    </div>
    <h1 style="color:#e8eef7;font-size:22px;font-weight:800;margin:0 0 8px;line-height:1.2;">
      ${recoveredVendors.length === 1 ? `${recoveredVendors[0].name} has recovered` : `${recoveredVendors.length} vendors are back online`}
    </h1>
    <p style="color:#9fb0c7;font-size:13px;margin:0;">${date}</p>
  </div>

  <!-- Recovered vendors -->
  <div style="background:#121923;border:1px solid rgba(61,225,158,0.3);border-radius:12px;overflow:hidden;margin-bottom:18px;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e2e3e;background:#0d1f17;font-size:12px;font-weight:700;color:#3de19e;text-transform:uppercase;letter-spacing:.05em;">
      ✅ Recovered
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${vendorRows}
    </table>
  </div>

  <!-- View dashboard -->
  <div style="text-align:center;padding:20px 0;">
    <a href="${siteUrl}/vendor-watch/" style="display:inline-block;background:#3de19e;color:#071018;font-weight:700;font-size:14px;padding:11px 26px;border-radius:9px;text-decoration:none;">
      View Live Status Dashboard →
    </a>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1e2e3e;padding:18px 0;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 4px;">EdgeIQ Vendor Watch · <a href="${siteUrl}" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
    <p style="margin:0;">You're watching: ${vendorNames}</p>
    <p style="margin:6px 0 0;"><a href="mailto:alerts@edgeiqlabs.com?subject=Unsubscribe Vendor Watch ${email}" style="color:#9fb0c7;">Unsubscribe</a></p>
  </div>

</div>
</body>
</html>`;

  return { subject, html };
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

  const slackBody = {
    text: payload.message,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*[EdgeIQ Vendor Watch]* ${payload.severity === 'critical' ? '🔴' : '✅'} *${payload.vendor}*\n${payload.message}` } },
    ],
  };

  for (const wh of record.webhooks) {
    let body;
    if (isSlackOrTeams(wh.url)) {
      body = slackBody;
    } else if (isDiscord(wh.url)) {
      body = { content: `**[EdgeIQ Vendor Watch]** ${payload.severity === 'critical' ? '🔴' : '✅'} **${payload.vendor}**: ${payload.message}` };
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

async function sendEmail(env, to, subject, html) {
  const fromEmail = env.FROM_EMAIL || 'alerts@edgeiqlabs.com';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `EdgeIQ Vendor Watch <${fromEmail}>`,
      to: [to],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    console.error(`Email failed for ${to}: ${await resp.text()}`);
    return false;
  }
  return true;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.PULSE_KV || !env.RESEND_API_KEY) {
      console.error('Missing PULSE_KV or RESEND_API_KEY');
      return;
    }

    const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
    console.log('Vendor Watch cron started:', new Date().toISOString());

    // Fetch all current vendor statuses once (shared across all subscribers)
    const currentMap = await fetchVendorStatuses(env);
    if (!currentMap) {
      console.error('Could not fetch vendor statuses — aborting cron');
      return;
    }

    const list = await env.PULSE_KV.list({ prefix: 'vendor:' });
    console.log(`Processing ${list.keys.length} Vendor Watch subscriber(s)`);

    for (const key of list.keys) {
      let subscriber;
      try {
        const raw = await env.PULSE_KV.get(key.name);
        if (!raw) continue;
        subscriber = JSON.parse(raw);
      } catch { continue; }

      if (!subscriber.active || !subscriber.vendors?.length) continue;

      const { newOutages, recovered } = detectChanges(
        subscriber.vendors,
        subscriber.last_statuses || {},
        currentMap
      );

      // Send outage alert if any watched vendor just went down
      if (newOutages.length > 0) {
        const { subject, html } = buildOutageEmail({
          email: subscriber.email,
          plan: subscriber.plan,
          affectedVendors: newOutages,
          siteUrl,
        });
        try {
          await sendEmail(env, subscriber.email, subject, html);
          console.log(`Outage alert sent to ${subscriber.email}: ${newOutages.map(v => v.name).join(', ')}`);
        } catch (err) {
          console.error(`Outage email error for ${subscriber.email}:`, err.message);
        }
        for (const v of newOutages) {
          await deliverWebhooks(env, subscriber.email, subscriber.domain, {
            type: 'vendor_outage', source: 'edgeiq', domain: subscriber.domain,
            vendor: v.name, severity: v.status === 'outage' ? 'critical' : 'warning',
            message: `${v.name} is reporting ${v.status}. ${v.description || ''}`.trim(),
            timestamp: new Date().toISOString(),
            details: { vendor_id: v.id, status: v.status, category: v.category },
          });
        }
      }

      // Send all-clear only to Pro subscribers
      if (recovered.length > 0 && subscriber.plan === 'pro') {
        const { subject, html } = buildAllClearEmail({
          email: subscriber.email,
          plan: subscriber.plan,
          recoveredVendors: recovered,
          siteUrl,
        });
        try {
          await sendEmail(env, subscriber.email, subject, html);
          console.log(`All-clear sent to ${subscriber.email}: ${recovered.map(v => v.name).join(', ')}`);
        } catch (err) {
          console.error(`All-clear email error for ${subscriber.email}:`, err.message);
        }
        for (const v of recovered) {
          await deliverWebhooks(env, subscriber.email, subscriber.domain, {
            type: 'vendor_recovered', source: 'edgeiq', domain: subscriber.domain,
            vendor: v.name, severity: 'info',
            message: `${v.name} has recovered and is operational.`,
            timestamp: new Date().toISOString(),
            details: { vendor_id: v.id, status: 'operational', previous_status: v.prevStatus },
          });
        }
      }

      // Update last_statuses and last_check in KV
      const updatedStatuses = buildCurrentStatuses(subscriber.vendors, currentMap);
      const updated = {
        ...subscriber,
        last_check: new Date().toISOString(),
        last_statuses: updatedStatuses,
      };
      try {
        await env.PULSE_KV.put(key.name, JSON.stringify(updated), {
          metadata: {
            email: subscriber.email,
            plan: subscriber.plan,
            product: 'vendor-watch',
            vendor_count: subscriber.vendors.length,
            last_check: updated.last_check,
          },
        });
      } catch (err) {
        console.error(`KV update failed for ${subscriber.email}:`, err.message);
      }

      // Small delay to avoid hammering Resend
      await new Promise(r => setTimeout(r, 300));
    }

    console.log('Vendor Watch cron complete:', new Date().toISOString());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger' && url.searchParams.get('secret') === env.TRIGGER_SECRET) {
      await this.scheduled({}, env, {});
      return new Response('Vendor Watch cron triggered.', { status: 200 });
    }
    return new Response('EdgeIQ Vendor Watch Cron Worker', { status: 200 });
  },
};
