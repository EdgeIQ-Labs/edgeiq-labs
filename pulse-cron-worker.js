/**
 * EdgeIQ Pulse — Weekly Cron Scanner Worker
 *
 * DEPLOY AS A SEPARATE CLOUDFLARE WORKER (not a Pages Function).
 * This worker handles the scheduled scan + email digest logic.
 *
 * SETUP (one-time):
 * 1. Create a new Cloudflare Worker named "edgeiq-pulse-cron"
 * 2. Paste this file as the worker script
 * 3. Add a Cron Trigger: "0 8 * * 1" (every Monday at 08:00 UTC)
 * 4. Bind the same KV namespace used by Pages:
 *    - Variable name: PULSE_KV
 * 5. Add environment variables:
 *    - RESEND_API_KEY  → your key from resend.com (free: 3,000 emails/month)
 *    - FROM_EMAIL      → alerts@edgeiqlabs.com
 *    - SITE_URL        → https://edgeiqlabs.com
 *
 * HOW IT WORKS:
 * On each cron tick, the worker:
 *   1. Lists all subscribers from KV (prefix "sub:")
 *   2. For each subscriber, runs 6 free-tier scans (or 13 for pro/business)
 *   3. Compares results to last_findings stored in KV
 *   4. If anything changed, sends a Resend email digest
 *   5. Updates KV with new findings + last_scan timestamp
 */

const WORKER_URLS = {
  ssl:      'https://edgeiq-ssl-checker.gpalmieri21.workers.dev',
  headers:  'https://edgeiq-headers-checker.gpalmieri21.workers.dev',
  xss:      'https://edgeiq-xss-scanner.gpalmieri21.workers.dev',
  subdomains:'https://edgeiq-subdomain-hunter.gpalmieri21.workers.dev',
  dns:      'https://edgeiq-dns-lookup.gpalmieri21.workers.dev',
  cve:      'https://edgeiq-cve-match.gpalmieri21.workers.dev',
  // Pro/Business only:
  dast:     'https://edgeiq-dast-scanner.gpalmieri21.workers.dev',
  api:      'https://edgeiq-api-scanner.gpalmieri21.workers.dev',
  cspm:     'https://edgeiq-cspm-scanner.gpalmieri21.workers.dev',
  threats:  'https://edgeiq-threats-scanner.gpalmieri21.workers.dev',
  docker:   'https://edgeiq-docker-scanner.gpalmieri21.workers.dev',
  asm:      'https://edgeiq-asm-scanner.gpalmieri21.workers.dev',
};

const FREE_SCANNERS   = ['ssl', 'headers', 'xss', 'subdomains', 'dns', 'cve'];
const PRO_SCANNERS    = [...FREE_SCANNERS, 'dast', 'api', 'cspm', 'threats', 'asm'];
const BIZ_SCANNERS    = [...PRO_SCANNERS, 'docker'];

function scannersForPlan(plan) {
  if (plan === 'business') return BIZ_SCANNERS;
  if (plan === 'pro') return PRO_SCANNERS;
  return FREE_SCANNERS;
}

async function runScan(scannerName, domain) {
  const url = WORKER_URLS[scannerName];
  if (!url) return null;
  try {
    const body = { domain, url: `https://${domain}`, host: domain, target: domain, software: domain };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

function extractSummary(scannerName, data) {
  if (!data || data.error) return { status: 'error', detail: data?.error || 'scan failed' };
  switch (scannerName) {
    case 'ssl':
      return { status: data.valid ? 'ok' : 'warning', detail: data.valid ? `Valid · ${data.daysLeft ?? '?'} days left` : (data.error || 'SSL issue detected') };
    case 'headers':
      return { status: data.grade === 'A' ? 'ok' : data.grade === 'F' ? 'bad' : 'warning', detail: `Grade ${data.grade || '?'} — ${data.missing?.length ?? 0} headers missing` };
    case 'xss':
      return { status: data.findings?.some(f => f.severity === 'high') ? 'bad' : 'ok', detail: data.summary || `${data.findings?.length ?? 0} findings` };
    case 'subdomains':
      return { status: 'ok', detail: `${data.total ?? 0} subdomains found`, count: data.total ?? 0 };
    case 'dns':
      return { status: 'ok', detail: data.summary || JSON.stringify(data).slice(0, 80) };
    case 'cve':
      return { status: (data.totalResults ?? 0) > 0 ? 'warning' : 'ok', detail: `${data.totalResults ?? 0} CVEs found` };
    default:
      return { status: 'ok', detail: data.summary || 'scanned' };
  }
}

function detectChanges(prev, curr) {
  const changes = [];
  for (const [key, val] of Object.entries(curr)) {
    const old = prev[key];
    if (!old) { changes.push({ scanner: key, type: 'new', curr: val.detail }); continue; }
    if (old.detail !== val.detail) changes.push({ scanner: key, type: 'changed', prev: old.detail, curr: val.detail });
    if (old.status !== val.status) changes.push({ scanner: key, type: 'status', prev: old.status, curr: val.status });
  }
  return changes;
}

const ICONS = { ssl:'🔒', headers:'📡', xss:'💉', subdomains:'🔗', dns:'🌐', cve:'🔎', dast:'🕷️', api:'🔌', cspm:'☁️', threats:'🚨', docker:'🐳', asm:'🗺️' };
const STATUS_COLOR = { ok:'#70f0a8', warning:'#ffb347', bad:'#ff6b6b', error:'#9fb0c7' };
const STATUS_LABEL = { ok:'✅ Clean', warning:'⚠️ Warning', bad:'🚨 Issue Found', error:'⚙️ Scan Error' };

function buildEmailHtml(domain, findings, changes, plan, siteUrl) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const hasChanges = changes.length > 0;

  const findingRows = Object.entries(findings).map(([name, f]) => {
    const color = STATUS_COLOR[f.status] || '#9fb0c7';
    const label = STATUS_LABEL[f.status] || f.status;
    return `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:14px;color:#e8eef7;">
          ${ICONS[name] || '🔍'} ${name.replace(/_/g,' ')}
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:13px;color:${color};">${label}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:13px;color:#9fb0c7;">${f.detail}</td>
      </tr>`;
  }).join('');

  const changeRows = changes.length === 0
    ? '<p style="color:#9fb0c7;font-size:13px;margin:0;">No changes detected since last scan. All checks match previous results.</p>'
    : changes.map(c => `
      <div style="background:#121923;border:1px solid #1e2e3e;border-radius:8px;padding:12px 16px;margin-bottom:8px;font-size:13px;">
        <strong style="color:#e8eef7;">${ICONS[c.scanner] || '🔍'} ${c.scanner}</strong>
        ${c.type === 'new' ? `<span style="color:#3de19e;margin-left:8px;">new check</span>` : ''}
        <br>
        ${c.prev ? `<span style="color:#9fb0c7;">Was: ${c.prev}</span><br>` : ''}
        <span style="color:#ffb347;">Now: ${c.curr}</span>
      </div>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>EdgeIQ Pulse — ${domain}</title></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="text-align:center;padding:32px 0 24px;">
    <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(61,225,158,0.12);border:1px solid rgba(61,225,158,0.35);color:#3de19e;font-size:11px;font-weight:700;padding:4px 12px;border-radius:16px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:16px;">
      ● PULSE WEEKLY DIGEST
    </div>
    <h1 style="color:#e8eef7;font-size:22px;font-weight:800;margin:0 0 6px;">${domain}</h1>
    <p style="color:#9fb0c7;font-size:13px;margin:0;">${date} · ${plan.charAt(0).toUpperCase()+plan.slice(1)} plan · ${Object.keys(findings).length} checks run</p>
  </div>

  <!-- Change Summary -->
  <div style="background:#0d1f17;border:1px solid ${hasChanges ? 'rgba(255,179,71,0.35)' : 'rgba(61,225,158,0.25)'};border-radius:12px;padding:20px;margin-bottom:18px;">
    <h2 style="color:${hasChanges ? '#ffb347' : '#3de19e'};font-size:15px;font-weight:700;margin:0 0 12px;">
      ${hasChanges ? `⚠️ ${changes.length} change${changes.length > 1 ? 's' : ''} detected since last scan` : '✅ No changes — all clear'}
    </h2>
    ${changeRows}
  </div>

  <!-- Full Scan Results -->
  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:12px;overflow:hidden;margin-bottom:18px;">
    <div style="padding:14px 16px;border-bottom:1px solid #1e2e3e;font-size:13px;font-weight:700;color:#9fb0c7;text-transform:uppercase;letter-spacing:.05em;">Full Scan Results</div>
    <table style="width:100%;border-collapse:collapse;">
      ${findingRows}
    </table>
  </div>

  <!-- CTA -->
  <div style="text-align:center;padding:24px 0 16px;">
    <a href="${siteUrl}/#scanner" style="display:inline-block;background:#3de19e;color:#071018;font-weight:700;font-size:14px;padding:12px 28px;border-radius:9px;text-decoration:none;margin-bottom:14px;">
      Run a deeper scan →
    </a>
    <br>
    ${plan === 'free' ? `<a href="${siteUrl}/pulse/#pricing" style="color:#3dd9ff;font-size:12px;">Upgrade to Pro for daily scans + all 13 checks →</a>` : ''}
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1e2e3e;padding:20px 0;text-align:center;font-size:11px;color:#4a6080;">
    <p style="margin:0 0 6px;">EdgeIQ Pulse · <a href="${siteUrl}" style="color:#9fb0c7;">edgeiqlabs.com</a></p>
    <p style="margin:0;">You're receiving this because you registered ${domain} for Pulse monitoring.</p>
    <p style="margin:6px 0 0;"><a href="mailto:support@edgeiqlabs.com?subject=Unsubscribe Pulse ${domain}" style="color:#9fb0c7;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
}

async function sendDigest(env, subscriber, findings, changes) {
  const { email, domain, plan } = subscriber;
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const fromEmail = env.FROM_EMAIL || 'alerts@edgeiqlabs.com';

  const hasChanges = changes.length > 0;
  const subject = hasChanges
    ? `⚠️ EdgeIQ Pulse — ${changes.length} change${changes.length > 1 ? 's' : ''} on ${domain}`
    : `✅ EdgeIQ Pulse — All clear for ${domain}`;

  const html = buildEmailHtml(domain, findings, changes, plan, siteUrl);

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `EdgeIQ Pulse <${fromEmail}>`,
      to: [email],
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`Email send failed for ${email} / ${domain}: ${err}`);
    return false;
  }
  return true;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.PULSE_KV) {
      console.error('PULSE_KV binding not configured. Add KV namespace in Worker settings.');
      return;
    }
    if (!env.RESEND_API_KEY) {
      console.error('RESEND_API_KEY not set. Add it in Worker environment variables.');
      return;
    }

    console.log('Pulse cron started:', new Date().toISOString());

    // List all subscribers
    let keys;
    try {
      const list = await env.PULSE_KV.list({ prefix: 'sub:' });
      keys = list.keys;
    } catch (err) {
      console.error('KV list failed:', err.message);
      return;
    }

    console.log(`Processing ${keys.length} subscriber(s)`);

    for (const key of keys) {
      let subscriber;
      try {
        const raw = await env.PULSE_KV.get(key.name);
        if (!raw) continue;
        subscriber = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!subscriber.active) continue;

      const { email, domain, plan, last_findings } = subscriber;
      const scanners = scannersForPlan(plan);

      // Run all scans concurrently
      const results = await Promise.all(scanners.map(async (name) => {
        const data = await runScan(name, domain);
        return [name, extractSummary(name, data)];
      }));

      const findings = Object.fromEntries(results);
      const prevFindings = last_findings || {};
      const changes = detectChanges(prevFindings, findings);

      // Send email
      try {
        await sendDigest(env, subscriber, findings, changes);
      } catch (err) {
        console.error(`Email error for ${email}:`, err.message);
      }

      // Update KV with new scan state
      const updated = {
        ...subscriber,
        last_scan: new Date().toISOString(),
        last_findings: findings,
      };
      try {
        await env.PULSE_KV.put(key.name, JSON.stringify(updated), {
          metadata: { email, domain, plan, last_scan: updated.last_scan },
        });
      } catch (err) {
        console.error(`KV update failed for ${email}:`, err.message);
      }

      // Small delay between subscribers to avoid hammering workers
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('Pulse cron complete:', new Date().toISOString());
  },

  // Allow manual trigger via HTTP for testing: GET /trigger?secret=XXX
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger' && url.searchParams.get('secret') === env.TRIGGER_SECRET) {
      await this.scheduled({}, env, {});
      return new Response('Pulse cron triggered manually.', { status: 200 });
    }
    return new Response('EdgeIQ Pulse Cron Worker', { status: 200 });
  },
};
