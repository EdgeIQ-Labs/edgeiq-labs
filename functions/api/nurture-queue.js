/**
 * Email Nurture Sequence Queue Processor
 * Triggered by Hermes cron every 6 hours (CF Pages crons disabled due to CPU limits)
 *
 * Reads `nurture:pending` array from PULSE_KV, sends due emails via Resend,
 * advances steps, handles retries. Auth-gated with X-Internal-Key header.
 *
 * Uses the rich HTML email builders from capture-email.js for consistent branding.
 */

// ── Shared design tokens (must match capture-email.js) ────────────────────────
const S = {
  bg:     '#0b0f14',
  card:   '#121923',
  card2:  '#0e1621',
  text:   '#e8eef7',
  muted:  '#9fb0c7',
  border: '#1e2e3e',
  accent: '#3dd9ff',
};

const FROM_ADDRESS = 'EdgeIQ Labs <security@edgeiqlabs.com>';
const COMPLIANCE_FROM = 'EdgeIQ Labs Compliance <compliance@edgeiqlabs.com>';
const RESEND_URL = 'https://api.resend.com/emails';

// ── Email shell ───────────────────────────────────────────────────────────────
function emailWrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:${S.bg};font-family:Inter,system-ui,Arial,sans-serif;color:${S.text};">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 20px;">
    <span style="font-size:18px;font-weight:800;color:${S.text};">EdgeIQ<span style="color:${S.accent}"> Labs</span></span>
  </td></tr>
  <tr><td style="background:${S.card};border:1px solid ${S.border};border-radius:12px;padding:28px 24px;">
    ${body}
  </td></tr>
  <tr><td style="padding:20px 0 0;text-align:center;">
    <p style="font-size:11px;color:#4a6080;line-height:1.6;margin:0;">
      EdgeIQ Labs · Small business security made simple<br>
      <a href="https://edgeiqlabs.com/free-tools/" style="color:${S.accent};text-decoration:none;">Free tools</a> ·
      <a href="https://edgeiqlabs.com/pricing/" style="color:${S.accent};text-decoration:none;">Pricing</a> ·
      <a href="https://edgeiqlabs.com/blog/" style="color:${S.accent};text-decoration:none;">Blog</a>
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Unsubscribe footer (CAN-SPAM: every nurture email carries one) ───────────
function unsubFooter(email) {
  const href = `https://edgeiqlabs.com/api/nurture-unsub?email=${encodeURIComponent(email || '')}`;
  return `<p style="font-size:11px;color:#4a6080;line-height:1.6;margin:18px 0 0;border-top:1px solid ${S.border};padding-top:14px;">
    You're getting this because you used a free EdgeIQ tool or downloaded a resource.
    <a href="${href}" style="color:#6b8299;text-decoration:underline;">Unsubscribe from these follow-ups</a>.
  </p>`;
}

// ── Nurture Email 2: Day 3 — actionable insights ─────────────────────────────
function buildNurtureEmail2(source, domain, recipient) {
  const subject = source === 'domain-security-score'
    ? `3 security wins for ${domain} (under 10 min each)`
    : '3 security wins you can implement today';

  const gaps = [
    {
      num: '01', color: '#ff9f43',
      title: 'Your domain can probably be spoofed right now',
      detail: 'If your DMARC record is set to <code style="background:#1a2535;color:#7dd3fc;padding:1px 5px;border-radius:3px;font-size:12px;">p=none</code> or doesn\'t exist, anyone can send email that appears to come from your CEO\'s exact address. ~80% of SMB domains have this gap.',
      cta_text: 'Check your DMARC →', cta_href: 'https://edgeiqlabs.com/inbox-shield/',
    },
    {
      num: '02', color: '#f472b6',
      title: 'Attackers may have registered a lookalike of your domain',
      detail: 'Typosquatters register domains like <code style="background:#1a2535;color:#7dd3fc;padding:1px 5px;border-radius:3px;font-size:12px;">cornpany.com</code> weeks before running phishing campaigns. By the time customers report fake emails, damage is done.',
      cta_text: 'Check for lookalikes →', cta_href: 'https://edgeiqlabs.com/brandguard/',
    },
    {
      num: '03', color: S.accent,
      title: 'Forgotten subdomains can be hijacked against you',
      detail: 'When SaaS trials end or services are decommissioned, DNS records often stay pointed at them. An attacker can claim the abandoned service and serve phishing pages from your own subdomain.',
      cta_text: 'Scan for exposed subdomains →', cta_href: 'https://edgeiqlabs.com/dashboard/',
    },
  ];

  const gapRows = gaps.map(g => `
    <div style="background:${S.card2};border:1px solid ${S.border};border-radius:10px;padding:16px 18px;margin-bottom:12px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:${g.color};margin-bottom:6px;">GAP ${g.num}</div>
      <div style="font-size:14px;font-weight:700;color:${S.text};margin-bottom:6px;line-height:1.3;">${g.title}</div>
      <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:0 0 10px;">${g.detail}</p>
      <a href="${g.cta_href}" style="font-size:12px;font-weight:700;color:${g.color};text-decoration:none;">${g.cta_text}</a>
    </div>`).join('');

  const html = emailWrap(`
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">🔍 Security Gaps</div>
    <h1 style="font-size:20px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">3 security wins you can implement today</h1>
    <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 20px;">These aren't exotic attack techniques. They're the same configuration gaps that show up in breach after breach — and they're all checkable in under two minutes.</p>
    ${gapRows}
    <p style="font-size:13px;color:${S.muted};line-height:1.6;margin:16px 0 0;border-top:1px solid ${S.border};padding-top:16px;">All three checks are free. In my next email I'll cover how to automate these so you never have to remember to re-check manually.</p>
    ${unsubFooter(recipient)}
  `);
  return { subject, html };
}

// ── Nurture Email 3: Day 7 — soft upsell ─────────────────────────────────────
function buildNurtureEmail3(source, domain, recipient) {
  const isDss = source === 'domain-security-score';
  const subject = isDss
    ? `Stop manually checking ${domain} — automate it free for 14 days`
    : 'Which EdgeIQ plan is right for you? (quick guide)';

  if (isDss) {
    const checks = [
      { icon: '🔐', text: 'SSL/TLS certificate health & expiry warnings' },
      { icon: '✉️', text: 'DMARC, SPF & DKIM email authentication' },
      { icon: '🛡️', text: 'HTTP security headers (CSP, HSTS, X-Frame-Options)' },
      { icon: '🌐', text: 'Subdomain exposure & DNS record changes' },
      { icon: '🔍', text: 'Open ports & service fingerprinting' },
    ];
    const checkRows = checks.map(c => `
      <tr>
        <td style="padding:7px 0;width:26px;font-size:1rem;vertical-align:top;">${c.icon}</td>
        <td style="padding:7px 0;font-size:13px;color:${S.muted};line-height:1.5;">${c.text}</td>
      </tr>`).join('');

    const html = emailWrap(`
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">⚡ Pulse Pro</div>
      <h1 style="font-size:20px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">Never manually check <span style="color:${S.accent};">${domain}</span> again</h1>
      <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 20px;">Pulse Pro scans your domain every week and emails you the moment anything changes. Here's what it watches:</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">${checkRows}</table>
      <div style="background:${S.card2};border:1px solid ${S.border};border-radius:10px;padding:22px;text-align:center;">
        <div style="font-size:24px;font-weight:900;color:${S.accent};margin-bottom:4px;">$19 / month</div>
        <div style="font-size:13px;color:${S.muted};margin-bottom:4px;">Unlimited domains · Weekly automated scans · Email digest</div>
        <div style="font-size:12px;color:#22c55e;font-weight:700;margin-bottom:18px;">✦ 14-day free trial — no charge until day 15</div>
        <a href="https://edgeiqlabs.com/pulse/#pricing" style="display:inline-block;background:${S.accent};color:#071018;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;text-decoration:none;">Start free trial →</a>
      </div>
      <p style="font-size:12px;color:#4a6080;line-height:1.6;margin:20px 0 0;border-top:1px solid ${S.border};padding-top:16px;">No credit card required until day 15. Cancel any time before then — you'll never be charged.</p>
      ${unsubFooter(recipient)}
    `);
    return { subject, html };
  }

  // Generic path: plan comparison
  const plans = [
    { icon: '🟢', name: 'Pulse Pro', color: S.accent, price: '$19/mo', best: 'Automated infrastructure monitoring', href: 'https://edgeiqlabs.com/pulse/#pricing' },
    { icon: '📋', name: 'Compliance Shield', color: '#3de19e', price: '$29/mo', best: 'SOC 2 / HIPAA readiness tracking', href: 'https://edgeiqlabs.com/compliance-shield/' },
    { icon: '🛡️', name: 'BrandGuard', color: '#f472b6', price: '$14/mo', best: 'Lookalike domain monitoring', href: 'https://edgeiqlabs.com/brandguard/' },
  ];
  const planCards = plans.map(p => `
    <div style="background:${S.card2};border:1px solid ${S.border};border-radius:10px;padding:16px 18px;margin-bottom:10px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:1.3rem;width:36px;vertical-align:top;">${p.icon}</td>
        <td style="vertical-align:top;">
          <span style="font-size:14px;font-weight:700;color:${p.color};">${p.name}</span>
          <span style="font-size:13px;font-weight:700;color:${S.text};margin-left:8px;">${p.price}</span>
          <div style="font-size:12px;color:${S.muted};margin-top:4px;">${p.best}</div>
          <a href="${p.href}" style="font-size:12px;font-weight:700;color:${p.color};text-decoration:none;margin-top:6px;display:inline-block;">Learn more →</a>
        </td>
      </tr></table>
    </div>`).join('');

  const html = emailWrap(`
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${S.accent};margin-bottom:12px;">💡 Pick Your Plan</div>
    <h1 style="font-size:20px;font-weight:800;color:${S.text};margin:0 0 14px;line-height:1.3;">Which EdgeIQ product is right for you?</h1>
    <p style="font-size:14px;color:${S.muted};line-height:1.7;margin:0 0 20px;">Each product targets a specific security blind spot. Most teams start with one and add more as they find gaps.</p>
    ${planCards}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td align="center" style="padding:8px 0 8px;">
      <a href="https://edgeiqlabs.com/pricing/" style="display:inline-block;background:${S.accent};color:#071018;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;text-decoration:none;">Compare all plans →</a>
    </td></tr></table>
    <p style="font-size:12px;color:#4a6080;line-height:1.6;margin:16px 0 0;border-top:1px solid ${S.border};padding-top:16px;">All products have a free tier or free trial. Questions? Just reply to this email.</p>
    ${unsubFooter(recipient)}
  `);
  return { subject, html };
}

// ── Send helper ───────────────────────────────────────────────────────────────
async function sendEmail(env, to, payload) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'No RESEND_API_KEY' };
  const unsubUrl = `https://edgeiqlabs.com/api/nurture-unsub?email=${encodeURIComponent(to)}`;
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
        ...payload,
      }),
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `Resend ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { env, request } = context;

  // Auth gate — fail closed. No hardcoded fallback: a default key committed to
  // the repo is public, and this endpoint spends the Resend quota.
  const validKey = env.NURTURE_INTERNAL_KEY;
  if (!validKey) {
    return Response.json({ ok: false, error: 'NURTURE_INTERNAL_KEY not configured' }, { status: 503 });
  }
  if (request.headers.get('X-Internal-Key') !== validKey) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const pending = await env.PULSE_KV.get('nurture:pending', 'json') || [];
    const now = Date.now();
    const HOUR = 3600 * 1000;
    // Cadence anchors off the last send, not enrollment, so a missed tick can
    // never fire two emails back-to-back.
    const STEP_DELAY_H = { 1: 48, 2: 72 };   // step1 ~day 2-3, step2 ~day 5-6
    const MAX_SENDS_PER_TICK = 40;           // stay inside CF CPU + Resend daily cap
    const MAX_ATTEMPTS = 5;

    const remaining = [];
    let sent = 0, failed = 0, skipped = 0, completed = 0, dropped = 0;

    for (const entry of pending) {
      // Retain unsubscribers as tombstones so re-capture can't resurrect them.
      if (entry.unsubscribed) { remaining.push(entry); skipped++; continue; }

      const step = Number.isInteger(entry.step) ? entry.step : 0;
      if (step >= 2) { remaining.push({ ...entry, completed: true }); completed++; continue; }

      const nextStep = step + 1;
      const anchor = entry.last_sent_at || entry.enqueued_at || now;
      const due = (now - anchor) >= STEP_DELAY_H[nextStep] * HOUR;

      if (!due || sent >= MAX_SENDS_PER_TICK) { remaining.push(entry); skipped++; continue; }

      const builder = nextStep === 1 ? buildNurtureEmail2 : buildNurtureEmail3;
      const payload = builder(entry.source, entry.domain, entry.email);
      const result = await sendEmail(env, entry.email, payload);

      if (result.ok) {
        sent++;
        const advanced = { ...entry, step: nextStep, last_sent_at: now, attempts: 0 };
        delete advanced.targetStep;
        if (nextStep >= 2) { advanced.completed = true; completed++; }
        remaining.push(advanced);
      } else {
        failed++;
        const attempts = (entry.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          remaining.push({ ...entry, attempts, dead: true, last_error: result.error });
          dropped++;
        } else {
          remaining.push({ ...entry, attempts, last_error: result.error });
        }
      }
    }

    await env.PULSE_KV.put('nurture:pending', JSON.stringify(remaining));

    return Response.json({
      ok: true,
      sent,
      failed,
      skipped,
      completed,
      dropped,
      queue_size: remaining.length,
      active: remaining.filter(e => !e.unsubscribed && !e.completed && !e.dead).length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
