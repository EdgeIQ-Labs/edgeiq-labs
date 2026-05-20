/**
 * EdgeIQ — Email capture + drip sequence
 * POST /api/capture-email
 * Body: { email, source? }
 *
 * 1. Subscribes to Substack newsletter
 * 2. Sends 3-email Resend drip:
 *    - Email 1: immediate  — welcome + free tools overview
 *    - Email 2: +3 days    — 3 security gaps most businesses miss
 *    - Email 3: +7 days    — which EdgeIQ product is right for you
 *
 * Env vars: RESEND_API_KEY
 */

const FROM_ADDRESS = 'EdgeIQ Labs <security@edgeiqlabs.com>';
const SUBSTACK_URL = 'https://edgeiqlabs.substack.com/api/v1/free';
const RESEND_URL   = 'https://api.resend.com/emails';

// ── Styles shared across all emails ──────────────────────────────────────────

const S = {
  bg:     '#0b0f14',
  card:   '#121923',
  card2:  '#0e1621',
  text:   '#e8eef7',
  muted:  '#9fb0c7',
  border: '#1e2e3e',
  accent: '#3dd9ff',
};

// ── Email builders ────────────────────────────────────────────────────────────

function emailWrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:Inter,system-ui,Arial,sans-serif;color:${S.text};">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 20px;">
    <span style="font-size:18px;font-weight:800;color:${S.text};">EdgeIQ<span style="color:${S.accent}"> Labs</span></span>
  </td></tr>
  <tr><td style="background:${S.card};border:1px solid ${S.border};border-radius:14px;padding:32px;">
    ${body}
  </td></tr>
  <tr><td style="padding:20px 0 0;text-align:center;">
    <p style="font-size:11px;color:#4a6080;line-height:1.6;margin:0;">
      EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:#4a6080;">edgeiqlabs.com</a><br>
      <a href="https://edgeiqlabs.com/account/" style="color:#4a6080;">Manage preferences</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildEmail1() {
  const subject = 'Welcome to EdgeIQ — here\'s what you can check for free right now';
  const tools = [
    { icon: '🔍', name: 'Dashboard Free Scan', color: S.accent,    desc: 'SSL, HTTP headers, DNS, subdomain exposure — one scan, no account needed.',       href: 'https://edgeiqlabs.com/dashboard/' },
    { icon: '✉️', name: 'Inbox Shield',         color: '#b47aff',   desc: 'Check whether your domain can be spoofed (SPF, DMARC, DKIM) in 10 seconds.',       href: 'https://edgeiqlabs.com/inbox-shield/' },
    { icon: '📋', name: 'Compliance Scanner',   color: '#3de19e',   desc: 'Get a free SOC 2 / PCI readiness score for your domain — no sign-up required.',     href: 'https://edgeiqlabs.com/compliance/' },
    { icon: '🛡️', name: 'BrandGuard',            color: '#f472b6',   desc: 'See if attackers have registered lookalike domains to impersonate your brand.',     href: 'https://edgeiqlabs.com/brandguard/' },
  ];
  const toolRows = tools.map(t => `
    <tr><td style="padding:0 0 10px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="width:42px;vertical-align:top;padding-top:2px;font-size:1.3rem;">${t.icon}</td>
          <td style="vertical-align:top;">
            <a href="${t.href}" style="font-size:14px;font-weight:700;color:${t.color};text-decoration:none;">${t.name}</a>
            <p style="font-size:13px;color:${S.muted};margin:3px 0 0;line-height:1.5;">${t.desc}</p>
          </td>
        </tr>
      </table>
    </td></tr>`).join('');

  const html = emailWrap(`
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">👋 Welcome to EdgeIQ Labs</div>
    <h1 style="font-size:22px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">Your free security toolkit is ready</h1>
    <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 26px;">EdgeIQ gives small teams the same security visibility that used to require an enterprise budget. Here's everything you can check for free — no credit card, no account required:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">${toolRows}</table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 0 28px;">
      <a href="https://edgeiqlabs.com/dashboard/" style="display:inline-block;background:${S.accent};color:#071018;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;text-decoration:none;">Run your free scan →</a>
    </td></tr></table>
    <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:0;border-top:1px solid ${S.border};padding-top:18px;">Over the next week I'll send you two more emails — a quick breakdown of the security gaps most businesses discover too late, and a guide to picking the right monitoring tier for your risk profile.<br><br>No fluff. Unsubscribe any time.</p>
  `);
  return { subject, html };
}

function buildEmail2() {
  const subject = '3 security gaps that catch businesses off-guard (and how to check yours)';
  const gaps = [
    {
      num: '01', color: '#ff9f43',
      title: 'Your domain can probably be spoofed right now',
      detail: 'If your DMARC record is set to <code style="background:#1a2535;color:#7dd3fc;padding:1px 5px;border-radius:3px;font-size:12px;">p=none</code> — or doesn\'t exist — anyone can send email that appears to come from your CEO\'s exact address. No account compromise needed. ~80% of SMB domains have this gap.',
      cta_text: 'Check your domain →', cta_href: 'https://edgeiqlabs.com/inbox-shield/',
    },
    {
      num: '02', color: '#f472b6',
      title: 'Attackers may have already registered a lookalike of your domain',
      detail: 'Typosquatters register domains like <code style="background:#1a2535;color:#7dd3fc;padding:1px 5px;border-radius:3px;font-size:12px;">cornpany.com</code> or <code style="background:#1a2535;color:#7dd3fc;padding:1px 5px;border-radius:3px;font-size:12px;">company-corp.com</code> — weeks before running phishing campaigns. By the time customers report fake emails, damage is done.',
      cta_text: 'Check for lookalikes →', cta_href: 'https://edgeiqlabs.com/brandguard/',
    },
    {
      num: '03', color: S.accent,
      title: 'Forgotten subdomains can be hijacked and used against you',
      detail: 'When SaaS trials end or services are decommissioned, DNS records are often left pointing at them. An attacker can claim the abandoned service and serve phishing pages from your own subdomain — passing browser security checks.',
      cta_text: 'Scan for exposed subdomains →', cta_href: 'https://edgeiqlabs.com/dashboard/',
    },
  ];
  const gapRows = gaps.map(g => `
    <div style="background:${S.card2};border:1px solid ${S.border};border-radius:10px;padding:18px 20px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:${g.color};margin-bottom:8px;">GAP ${g.num}</div>
      <div style="font-size:15px;font-weight:700;color:${S.text};margin-bottom:8px;line-height:1.3;">${g.title}</div>
      <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:0 0 12px;">${g.detail}</p>
      <a href="${g.cta_href}" style="font-size:12px;font-weight:700;color:${g.color};text-decoration:none;">${g.cta_text}</a>
    </div>`).join('');

  const html = emailWrap(`
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">🔍 Security gaps</div>
    <h1 style="font-size:21px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">3 security gaps that catch businesses off-guard</h1>
    <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 22px;">These aren't exotic attack techniques. They're the same configuration gaps that show up in breach after breach — and they're all checkable in under two minutes.</p>
    ${gapRows}
    <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:18px 0 0;border-top:1px solid ${S.border};padding-top:18px;">All three checks are free. If you want them monitored automatically and alerted on every week, I'll cover the options in my next email.</p>
  `);
  return { subject, html };
}

function buildEmail3() {
  const subject = 'Which EdgeIQ plan is right for you? (quick guide)';
  const plans = [
    {
      icon: '🟢', name: 'Pulse Pro', color: S.accent, price: '$19/mo',
      best: 'Best for: teams who want automated infrastructure monitoring',
      points: ['Weekly SSL, header, DNS, port & subdomain scans', 'Email digest when anything changes', 'Covers unlimited domains'],
      href: 'https://edgeiqlabs.com/pulse/#pricing',
    },
    {
      icon: '📋', name: 'Compliance Pro', color: '#3de19e', price: '$9/mo',
      best: 'Best for: teams preparing for SOC 2, PCI, or HIPAA',
      points: ['Weekly automated compliance scans', 'Score history & trend tracking', 'Remediation roadmap delivered to your inbox'],
      href: 'https://edgeiqlabs.com/compliance/#plans',
    },
    {
      icon: '🛡️', name: 'BrandGuard', color: '#f472b6', price: '$14/mo',
      best: 'Best for: brands with customer-facing domains',
      points: ['24/7 lookalike & typosquatting monitoring', 'Instant alert on new impostors', 'Covers homoglyph, TLD swaps & keyword-append domains'],
      href: 'https://edgeiqlabs.com/brandguard/',
    },
    {
      icon: '🏢', name: 'Workspace Posture Pro', color: '#4da6ff', price: '$19/mo',
      best: 'Best for: M365 and Google Workspace admins',
      points: ['Weekly OAuth app & admin role audit', 'Forwarding rule & sign-in anomaly detection', 'MFA coverage report'],
      href: 'https://edgeiqlabs.com/workspace-posture/',
    },
  ];
  const planCards = plans.map(p => `
    <div style="background:${S.card2};border:1px solid ${S.border};border-radius:10px;padding:18px 20px;margin-bottom:12px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:1.3rem;width:36px;vertical-align:top;">${p.icon}</td>
        <td style="vertical-align:top;">
          <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
            <span style="font-size:15px;font-weight:700;color:${p.color};">${p.name}</span>
            <span style="font-size:13px;font-weight:700;color:${S.text};">${p.price}</span>
          </div>
          <div style="font-size:11px;color:${S.muted};margin-bottom:8px;">${p.best}</div>
          <ul style="margin:0 0 10px 16px;padding:0;">${p.points.map(pt => `<li style="font-size:12px;color:${S.muted};margin-bottom:3px;line-height:1.5;">${pt}</li>`).join('')}</ul>
          <a href="${p.href}" style="font-size:12px;font-weight:700;color:${p.color};text-decoration:none;">Get started →</a>
        </td>
      </tr></table>
    </div>`).join('');

  const html = emailWrap(`
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">💡 Pick your plan</div>
    <h1 style="font-size:21px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">Which EdgeIQ product is right for you?</h1>
    <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 22px;">Here's a quick guide — each product targets a specific security blind spot. Most teams start with one and add more as they find gaps.</p>
    ${planCards}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;"><tr><td align="center" style="padding:8px 0 20px;">
      <a href="https://edgeiqlabs.com/pricing/" style="display:inline-block;background:${S.accent};color:#071018;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;text-decoration:none;">Compare all plans →</a>
    </td></tr></table>
    <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:0;border-top:1px solid ${S.border};padding-top:18px;">All products have a free tier or free trial — no credit card needed to start. Questions? Just reply to this email.</p>
  `);
  return { subject, html };
}

// ── Send helper ───────────────────────────────────────────────────────────────

async function sendEmail(env, to, payload) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], ...payload }),
    });
  } catch (_) {}
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }

  const email  = ((body.email  || '')).trim().toLowerCase();
  const source = ((body.source || 'capture')).trim();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return Response.json({ ok: false, error: 'Invalid email' }, { status: 400 });
  }

  // 1. Add to Substack (fire-and-forget, errors ignored)
  fetch(SUBSTACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, first_url: source }),
  }).catch(() => {});

  // 2. Drip sequence via Resend
  if (env.RESEND_API_KEY) {
    const now   = Date.now();
    const day3  = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
    const day7  = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();

    const e1 = buildEmail1();
    const e2 = buildEmail2();
    const e3 = buildEmail3();

    // Send all three; emails 2 & 3 are scheduled via Resend scheduledAt
    await Promise.allSettled([
      sendEmail(env, email, e1),
      sendEmail(env, email, { ...e2, scheduledAt: day3 }),
      sendEmail(env, email, { ...e3, scheduledAt: day7 }),
    ]);
  }

  return Response.json({ ok: true });
}
