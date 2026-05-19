/**
 * EdgeIQ Compliance Monitor — Weekly Cron Worker
 *
 * DEPLOY AS A SEPARATE CLOUDFLARE WORKER (not a Pages Function).
 *
 * SETUP (one-time):
 * 1. npx wrangler deploy --config wrangler-compliance.toml
 * 2. Add cron trigger: "0 8 * * 1" (every Monday 08:00 UTC)
 * 3. Bind PULSE_KV (same namespace as Pulse/MSP)
 * 4. Add secrets: RESEND_API_KEY, FROM_EMAIL, SITE_URL
 *
 * HOW IT WORKS:
 * Lists all KV keys with prefix "compliance:", runs live DNS + HTTP
 * compliance checks for each subscriber, emails a digest, and updates KV
 * with the latest score + change data.
 */

// ── DNS / HTTP scan (mirrors functions/api/compliance.js) ────────────────────

const DOH      = 'https://cloudflare-dns.com/dns-query';
const SCAN_UA  = 'EdgeIQ-Compliance-Cron/1.0';
const T        = 7000; // timeout ms

async function dnsQuery(name, type) {
  try {
    const r = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(T) });
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

function getTxt(resp) {
  return (resp.Answer || []).filter(a => a.type === 16)
    .map(a => (a.data || '').replace(/^"|"$/g, '').replace(/" "/g, ''));
}
function hasMx(resp) { return resp.Status === 0 && (resp.Answer || []).some(a => a.type === 15); }

async function safeFetch(url, opts = {}) {
  try {
    const r = await fetch(url, {
      ...opts, method: opts.method || 'HEAD',
      headers: { 'User-Agent': SCAN_UA, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(T),
    });
    if (r.status === 405 && opts.method === 'HEAD') {
      return await fetch(url, { ...opts, method: 'GET', headers: { 'User-Agent': SCAN_UA }, signal: AbortSignal.timeout(T) });
    }
    return r;
  } catch { return null; }
}

async function runComplianceScan(domain) {
  const [httpsR, httpR, txtRoot, txtDmarc, mxR] = await Promise.all([
    safeFetch(`https://${domain}`, { method: 'HEAD', redirect: 'follow' }),
    safeFetch(`http://${domain}`,  { method: 'GET',  redirect: 'follow' }),
    dnsQuery(domain, 'TXT'),
    dnsQuery(`_dmarc.${domain}`, 'TXT'),
    dnsQuery(domain, 'MX'),
  ]);

  const httpsWorks   = !!(httpsR && httpsR.ok && httpsR.status < 400);
  const hdrs         = httpsR ? httpsR.headers : new Headers();
  const httpPortOpen = !!(httpR && httpR.status > 0);
  const httpToHttps  = !!(httpR && (httpR.url || '').startsWith('https://'));

  const hstsRaw  = hdrs.get('strict-transport-security') || '';
  const hsts     = hstsRaw.length > 0;
  const m        = hstsRaw.match(/max-age=(\d+)/i);
  const hstsLong = m ? parseInt(m[1], 10) >= 31536000 : false;

  const cspRaw        = hdrs.get('content-security-policy') || '';
  const cspPresent    = cspRaw.length > 0;
  const cspLow        = cspRaw.toLowerCase();
  const cspDefaultSrc = cspLow.includes('default-src');
  const cspScriptSrc  = cspLow.includes('script-src');
  const cspFrame      = cspLow.includes('frame-ancestors');

  const xfo      = (hdrs.get('x-frame-options') || '').length > 0;
  const xcto     = /nosniff/i.test(hdrs.get('x-content-type-options') || '');
  const refPol   = (hdrs.get('referrer-policy') || '').length > 0;
  const permPol  = (hdrs.get('permissions-policy') || hdrs.get('feature-policy') || '').length > 0;

  const server   = hdrs.get('server') || '';
  const srvLeak  = server.length > 0 && (/[\d\.]{3,}/.test(server) || /apache|nginx|iis|litespeed|openresty|caddy|gunicorn|uvicorn/i.test(server));
  const xpb      = hdrs.get('x-powered-by') || '';
  const xpbPresent = xpb.length > 0;

  const setCookie   = hdrs.get('set-cookie') || '';
  const cookiesSeen = setCookie.length > 0;
  const cookieSecure   = !cookiesSeen || /\bsecure\b/i.test(setCookie);
  const cookieHttpOnly = !cookiesSeen || /\bhttponly\b/i.test(setCookie);

  const txts    = getTxt(txtRoot);
  const spf     = txts.some(t => /^v=spf1\b/i.test(t));
  const dmarcTx = getTxt(txtDmarc);
  const dmarc   = dmarcTx.some(t => /^v=DMARC1\b/i.test(t));
  const dmarcStrict = dmarcTx.some(t => /p=(quarantine|reject)/i.test(t));
  const mx      = hasMx(mxR);

  const c = { httpsWorks, httpPortOpen, httpRedirectsToHttps: httpToHttps, hsts, hstsLongAge: hstsLong,
    cspPresent, cspHasDefaultSrc: cspDefaultSrc, cspHasScriptSrc: cspScriptSrc, cspFrameAncestors: cspFrame,
    xFrameOptions: xfo, xContentTypeOptions: xcto, referrerPolicy: refPol, permissionsPolicy: permPol,
    serverHeader: server, serverVersionLeaks: srvLeak, xPoweredBy: xpb, xPoweredByPresent: xpbPresent,
    cookiesSeen, cookiesSecure: cookieSecure, cookiesHttpOnly: cookieHttpOnly,
    spfPresent: spf, dmarcPresent: dmarc, dmarcStrictPolicy: dmarcStrict, mxPresent: mx };

  const controls = evaluateAllControls(c);
  const avg      = Math.round(controls.reduce((s, r) => s + r.score, 0) / controls.length);
  return { score: avg, grade: grade(avg), controls };
}

// ── Control evaluators (compact) ─────────────────────────────────────────────

function pct(n) { return Math.round(n * 100); }
function st(r)  { return r >= 0.80 ? 'pass' : r >= 0.40 ? 'warning' : 'fail'; }
function grade(s) { return s >= 90 ? 'A' : s >= 70 ? 'B' : s >= 50 ? 'C' : s >= 30 ? 'D' : 'F'; }

function evalCC61(c) {
  let s = 0, action;
  if (c.httpsWorks) s += 0.40; else { action = action || 'HTTPS not working — domain unreachable over TLS'; }
  if (c.hsts)       s += 0.35; else { action = action || 'Add Strict-Transport-Security (HSTS) with max-age ≥ 31536000'; }
  if (!c.httpPortOpen || c.httpRedirectsToHttps) s += 0.25;
  else { action = action || 'HTTP port 80 open without redirect to HTTPS — add 301 redirect'; }
  return { id: 'CC6.1', name: 'Logical and Physical Access Controls', category: 'Security', score: pct(s), status: st(s), action: action || 'HTTPS, HSTS, and redirect all correctly configured.' };
}
function evalCC62(c) {
  let s = 0, action;
  if (c.xFrameOptions || c.cspFrameAncestors) s += 0.55; else { action = 'Add X-Frame-Options: DENY or CSP frame-ancestors to prevent clickjacking'; }
  if (c.xContentTypeOptions) s += 0.45; else { action = action || 'Add X-Content-Type-Options: nosniff'; }
  return { id: 'CC6.2', name: 'Logical Access Controls', category: 'Security', score: pct(s), status: st(s), action: action || 'Clickjacking and MIME protections in place.' };
}
function evalCC66(c) {
  let s = 0, action;
  if (c.referrerPolicy)    s += 0.35; else { action = 'Add Referrer-Policy header'; }
  if (c.permissionsPolicy) s += 0.30; else { action = action || 'Add Permissions-Policy header'; }
  s += c.cookiesSeen
    ? ((c.cookiesSecure   ? 0.175 : 0) + (c.cookiesHttpOnly ? 0.175 : 0))
    : 0.35;
  if (c.cookiesSeen && !c.cookiesSecure)   action = action || 'Session cookie missing Secure flag';
  if (c.cookiesSeen && !c.cookiesHttpOnly) action = action || 'Session cookie missing HttpOnly flag';
  return { id: 'CC6.6', name: 'Security for Remote Computing', category: 'Security', score: pct(s), status: st(s), action: action || 'Referrer-Policy, Permissions-Policy, and cookies correctly configured.' };
}
function evalCC72(c) {
  let s = 0, action;
  if (!c.serverVersionLeaks) s += 0.50; else { action = `Server header leaks version (${c.serverHeader.slice(0,30)}) — remove it`; }
  if (!c.xPoweredByPresent)  s += 0.50; else { action = action || `X-Powered-By exposes framework info — remove it`; }
  return { id: 'CC7.2', name: 'Vulnerability Management', category: 'Monitoring', score: pct(s), status: st(s), action: action || 'No version information exposed in headers.' };
}
function evalCC81(c) {
  let s = 0, action;
  if (c.spfPresent)   s += 0.50; else { action = 'No SPF record — domain can be spoofed in email'; }
  if (c.dmarcPresent) s += 0.50; else { action = action || 'No DMARC record — no email authentication policy'; }
  return { id: 'CC8.1', name: 'Change Management', category: 'Operations', score: pct(s), status: st(s), action: action || 'SPF and DMARC records found.' };
}
function evalA1(c) {
  let s = 0, action;
  if (c.cspPresent) { s += 0.45; s += (c.cspHasDefaultSrc || c.cspHasScriptSrc) ? 0.55 : 0.20; }
  else { action = 'No Content-Security-Policy header — add CSP with script-src directives'; }
  if (!action && !(c.cspHasDefaultSrc || c.cspHasScriptSrc)) action = 'CSP present but lacks default-src or script-src';
  return { id: 'A1', name: 'Injection', category: 'Application Security', score: pct(s), status: st(s), action: action || 'CSP configured with script-src directives.' };
}
function evalA3(c) {
  let s = 0, action;
  if (c.httpsWorks) s += 0.45; else { action = 'HTTPS not working — data-in-transit not protected'; }
  if (c.hstsLongAge) s += 0.35;
  else if (c.hsts) { s += 0.15; action = action || 'HSTS max-age below 1 year — set to ≥ 31536000'; }
  else { action = action || 'No HSTS header — connections can be downgraded'; }
  if (!c.httpPortOpen || c.httpRedirectsToHttps) s += 0.20;
  else { action = action || 'HTTP served without HTTPS redirect'; }
  return { id: 'A3', name: 'Data Integrity', category: 'Data Protection', score: pct(s), status: st(s), action: action || 'TLS, HSTS, and redirect all correctly configured.' };
}
function evalA5(c) {
  let s = 0, action;
  if (c.mxPresent)         s += 0.25; else { action = 'No MX records found'; }
  if (c.spfPresent)        s += 0.25; else { action = action || 'No SPF record'; }
  if (c.dmarcStrictPolicy) s += 0.50;
  else if (c.dmarcPresent) { s += 0.20; action = action || 'DMARC p=none — upgrade to quarantine/reject'; }
  else { action = action || 'No DMARC record'; }
  return { id: 'A5', name: 'Logging and Monitoring', category: 'Monitoring', score: pct(s), status: st(s), action: action || 'MX, SPF, and DMARC (enforced) all configured.' };
}

function evaluateAllControls(c) {
  return [evalCC61(c), evalCC62(c), evalCC66(c), evalCC72(c), evalCC81(c), evalA1(c), evalA3(c), evalA5(c)];
}

// ── Email digest builder ──────────────────────────────────────────────────────

const GRADE_COLOR = { A:'#3de19e', B:'#70f0a8', C:'#ffb347', D:'#ff8c42', F:'#ff6b6b' };
const STATUS_ICON = { pass:'✅', warning:'⚠️', fail:'❌' };

function buildEmail(domain, curr, prev, siteUrl) {
  const date      = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const gc        = GRADE_COLOR[curr.grade] || '#9fb0c7';
  const scoreDiff = prev ? curr.score - prev.score : null;
  const diffStr   = scoreDiff === null ? '' : scoreDiff > 0 ? ` <span style="color:#3de19e;">↑ +${scoreDiff}</span>` : scoreDiff < 0 ? ` <span style="color:#ff6b6b;">↓ ${scoreDiff}</span>` : ' <span style="color:#9fb0c7;">no change</span>';

  const passed  = curr.controls.filter(c => c.status === 'pass').length;
  const warning = curr.controls.filter(c => c.status === 'warning').length;
  const failed  = curr.controls.filter(c => c.status === 'fail').length;

  const controlRows = curr.controls.map(c => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:13px;color:#9fb0c7;">${STATUS_ICON[c.status] || '?'} ${c.id}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:13px;color:#e8eef7;">${c.name}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #1e2e3e;font-size:13px;font-weight:700;color:${c.status==='pass'?'#3de19e':c.status==='warning'?'#ffb347':'#ff6b6b'};">${c.score}%</td>
    </tr>`).join('');

  const topIssues = curr.controls.filter(c => c.status !== 'pass').slice(0, 3);
  const issueItems = topIssues.length === 0
    ? '<p style="color:#3de19e;font-size:13px;">All controls passing — great posture this week! 🎉</p>'
    : topIssues.map(c => `<div style="background:#121923;border:1px solid #1e2e3e;border-radius:8px;padding:12px 14px;margin-bottom:8px;"><strong style="color:#e8eef7;font-size:13px;">${c.id} — ${c.name}</strong><br><span style="color:#9fb0c7;font-size:12px;">${c.action}</span></div>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>EdgeIQ Compliance — ${domain}</title></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:20px;">

  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:16px;padding:28px 24px;margin-bottom:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <p style="margin:0;font-size:12px;color:#4a6080;text-transform:uppercase;letter-spacing:.06em;">EdgeIQ Compliance Digest</p>
        <h1 style="margin:4px 0 0;font-size:1.2rem;color:#e8eef7;">${domain}</h1>
        <p style="margin:2px 0 0;font-size:12px;color:#9fb0c7;">${date}</p>
      </div>
      <div style="text-align:center;background:rgba(61,225,158,0.05);border:2px solid ${gc};border-radius:50%;width:70px;height:70px;display:flex;flex-direction:column;align-items:center;justify-content:center;">
        <span style="font-size:24px;font-weight:900;color:${gc};line-height:1;">${curr.grade}</span>
        <span style="font-size:11px;color:#9fb0c7;">${curr.score}%${diffStr}</span>
      </div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:80px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:#3de19e;">${passed}</div>
        <div style="font-size:11px;color:#9fb0c7;">Passed</div>
      </div>
      <div style="flex:1;min-width:80px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:#ffb347;">${warning}</div>
        <div style="font-size:11px;color:#9fb0c7;">Warning</div>
      </div>
      <div style="flex:1;min-width:80px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:#ff6b6b;">${failed}</div>
        <div style="font-size:11px;color:#9fb0c7;">Failed</div>
      </div>
    </div>

    <h2 style="font-size:12px;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;">Control Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;background:#0b0f14;border-radius:8px;overflow:hidden;border:1px solid #1e2e3e;">
      ${controlRows}
    </table>
  </div>

  <div style="background:#121923;border:1px solid #1e2e3e;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
    <h2 style="font-size:12px;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:.06em;margin:0 0 12px;">Top Issues to Fix</h2>
    ${issueItems}
  </div>

  <div style="text-align:center;padding:16px;">
    <a href="${siteUrl}/compliance/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;font-size:13px;padding:11px 24px;border-radius:8px;text-decoration:none;margin-right:10px;">Open Compliance Dashboard →</a>
    <p style="margin:14px 0 0;font-size:11px;color:#4a6080;">
      <a href="${siteUrl}/account/" style="color:#3dd9ff;">Manage subscription</a> ·
      <a href="mailto:support@edgeiqlabs.com" style="color:#4a6080;">support@edgeiqlabs.com</a>
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── Send email via Resend ─────────────────────────────────────────────────────

async function sendDigest(env, email, domain, curr, prev) {
  if (!env.RESEND_API_KEY) return;
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const change  = prev ? (curr.score > prev.score ? `↑ +${curr.score - prev.score}` : curr.score < prev.score ? `↓ ${curr.score - prev.score}` : 'no change') : 'first scan';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'alerts@edgeiqlabs.com',
      to: email,
      subject: `Compliance Digest — ${domain} | ${curr.grade} (${curr.score}%) ${change}`,
      html: buildEmail(domain, curr, prev, siteUrl),
    }),
  }).catch(e => console.error('Resend error:', e.message));
}

// ── Main cron handler ─────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function runCron(env) {
  if (!env.PULSE_KV) { console.error('PULSE_KV binding missing'); return; }

  // List all compliance subscribers
  let cursor, keys = [];
  do {
    const page = await env.PULSE_KV.list({ prefix: 'compliance:', limit: 100, cursor });
    keys = keys.concat(page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  console.log(`Compliance cron: processing ${keys.length} subscribers`);

  for (const { name } of keys) {
    try {
      const raw = await env.PULSE_KV.get(name);
      if (!raw) continue;
      const record = JSON.parse(raw);
      if (!record.active || !record.email || !record.domain) continue;

      // Run live compliance scan
      const curr = await runComplianceScan(record.domain);
      const prev = record.last_score !== null ? { score: record.last_score, grade: record.last_grade } : null;

      // Send weekly digest
      await sendDigest(env, record.email, record.domain, curr, prev);

      // Update KV with latest results
      record.last_scan_at   = new Date().toISOString();
      record.last_score     = curr.score;
      record.last_grade     = curr.grade;
      record.last_controls  = curr.controls;
      record.scan_count     = (record.scan_count || 0) + 1;

      await env.PULSE_KV.put(name, JSON.stringify(record), {
        metadata: { email: record.email, domain: record.domain, plan: record.plan, last_score: curr.score },
      });

      console.log(`Compliance: ${record.domain} → ${curr.grade} (${curr.score}%)`);
    } catch (err) {
      console.error(`Error processing ${name}:`, err.message);
    }
  }

  console.log('Compliance cron complete');
}
