/**
 * EdgeIQ BrandGuard — Daily Lookalike Domain Scanner
 *
 * DEPLOY AS A SEPARATE CLOUDFLARE WORKER (not a Pages Function).
 *
 * SETUP (one-time):
 * 1. npx wrangler deploy --config wrangler-brandguard.toml
 * 2. Add cron trigger: "0 7 * * *" (daily at 07:00 UTC)
 * 3. Bind PULSE_KV (same namespace as other workers)
 * 4. Add secrets: RESEND_API_KEY, FROM_EMAIL, SITE_URL
 *
 * HOW IT WORKS:
 * For each subscriber, generates 60-80 typosquatting/lookalike variations of
 * their domain, performs parallel DNS checks, content-scans active ones for
 * phishing indicators, compares against last known state, and emails an alert
 * if anything changed. Also sends a weekly summary every Monday.
 */

const DOH      = 'https://cloudflare-dns.com/dns-query';
const SCAN_UA  = 'EdgeIQ-BrandGuard/1.0';
const DNS_T    = 3000; // DNS timeout ms (tight — we're running many in parallel)
const HTTP_T   = 6000; // HTTP content check timeout ms

// ── Domain variation generator ────────────────────────────────────────────────

function generateVariations(domain) {
  // domain = 'example.com'
  const dot = domain.lastIndexOf('.');
  const sld = domain.slice(0, dot);   // e.g. 'example'
  const tld = domain.slice(dot + 1);  // e.g. 'com'
  const alts = new Set();

  // 1. TLD swaps
  for (const t of ['com', 'net', 'org', 'io', 'co', 'info', 'biz', 'app', 'online', 'site', 'us', 'cc']) {
    if (t !== tld) alts.add(`${sld}.${t}`);
  }

  // 2. One-character deletions
  for (let i = 0; i < sld.length; i++) {
    const v = sld.slice(0, i) + sld.slice(i + 1);
    if (v.length > 2) alts.add(`${v}.${tld}`);
  }

  // 3. Adjacent character transpositions
  for (let i = 0; i < sld.length - 1; i++) {
    const a = sld.split('');
    [a[i], a[i + 1]] = [a[i + 1], a[i]];
    alts.add(`${a.join('')}.${tld}`);
  }

  // 4. Character doublings (fat-finger)
  for (let i = 0; i < sld.length; i++) {
    alts.add(`${sld.slice(0, i)}${sld[i]}${sld[i]}${sld.slice(i + 1)}.${tld}`);
  }

  // 5. Homoglyph swaps (common visual confusion)
  const glyphs = { a: '4', e: '3', i: '1', l: '1', o: '0', s: '5', t: '7' };
  for (const [ch, sub] of Object.entries(glyphs)) {
    if (sld.includes(ch)) {
      alts.add(`${sld.replace(new RegExp(ch, 'g'), sub)}.${tld}`);
    }
  }

  // 6. Brand-squatting prefixes
  for (const pre of ['my', 'get', 'the', 'go', 'try', 'use', 'app']) {
    alts.add(`${pre}${sld}.${tld}`);
    alts.add(`${pre}-${sld}.${tld}`);
  }

  // 7. Brand-squatting suffixes (phishing lure words)
  for (const suf of ['app', 'login', 'secure', 'help', 'support', 'verify', 'official', 'portal', 'account', 'signin']) {
    alts.add(`${sld}${suf}.${tld}`);
    alts.add(`${sld}-${suf}.${tld}`);
  }

  // 8. Hyphenated version
  if (!sld.includes('-')) {
    for (let i = 1; i < sld.length - 1; i++) {
      alts.add(`${sld.slice(0, i)}-${sld.slice(i)}.${tld}`);
    }
  }

  alts.delete(domain);
  return [...alts].slice(0, 100); // cap at 100 variations
}

// ── DNS check: is a domain registered/active? ─────────────────────────────────

async function hasARecord(variant) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(variant)}&type=A`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS_T) }
    );
    const d = await r.json();
    return d.Status === 0 && (d.Answer || []).some(a => a.type === 1);
  } catch { return false; }
}

// ── Phishing content analysis ─────────────────────────────────────────────────

async function analyzeContent(variant, brandName) {
  try {
    const r = await fetch(`https://${variant}`, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': SCAN_UA },
      signal: AbortSignal.timeout(HTTP_T),
    });
    if (!r.ok) return { live: false };
    // Read first 50KB only — enough to detect phishing indicators
    const reader = r.body.getReader();
    let html = '';
    while (html.length < 50000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel().catch(() => {});

    const low  = html.toLowerCase();
    const brand = brandName.replace(/\.[a-z]{2,}$/, '').toLowerCase(); // strip TLD for matching
    return {
      live:          true,
      mentionsBrand: low.includes(brand),
      hasLoginForm:  (low.includes('type="password"') || low.includes("type='password'")),
      hasCreditCard: /credit.?card|card.?number|cvv|ccv/i.test(html),
    };
  } catch { return { live: false }; }
}

// ── Batch DNS check with concurrency limit ────────────────────────────────────

async function checkDomainsInBatches(variants, batchSize = 15) {
  const active = [];
  for (let i = 0; i < variants.length; i += batchSize) {
    const batch   = variants.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async v => ({ v, active: await hasARecord(v) })));
    for (const { v, active: isA } of results) {
      if (isA) active.push(v);
    }
  }
  return active;
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildAlertEmail(domain, findings, newDomains, siteUrl) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const suspicious = findings.filter(f => f.suspicious);
  const active     = findings.filter(f => f.live && !f.suspicious);
  const registered = findings.filter(f => !f.live);

  const suspRow = suspicious.map(f => `
    <div style="background:#1a0e0e;border:1px solid rgba(255,107,107,0.4);border-radius:8px;padding:12px 14px;margin-bottom:8px;">
      <strong style="color:#ff6b6b;font-size:13px;">🚨 ${f.domain}</strong>
      <div style="font-size:12px;color:#9fb0c7;margin-top:4px;">
        ${f.mentionsBrand ? '⚠️ Mentions your brand · ' : ''}${f.hasLoginForm ? '⚠️ Has login/password form' : ''}${f.hasCreditCard ? ' · ⚠️ Requests card details' : ''}
      </div>
      <div style="font-size:11px;color:#4a6080;margin-top:6px;">Action: Visit domain → screenshot → file abuse report at registrar + ICANN Complaint Center</div>
    </div>`).join('');

  const activeRow = active.map(f => `
    <div style="background:#121923;border:1px solid #1e2e3e;border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:12px;color:#9fb0c7;">
      ⚠️ <strong style="color:#ffb347;">${f.domain}</strong> — serving content (no brand indicators detected)
    </div>`).join('');

  const regRow = registered.slice(0, 8).map(f => `
    <span style="background:#0e1621;border:1px solid #233142;border-radius:4px;padding:3px 8px;font-size:11px;color:#9fb0c7;margin:2px;display:inline-block;">${f.domain}</span>`).join('');

  const isAlert = newDomains.length > 0 || suspicious.length > 0;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>BrandGuard Report — ${domain}</title></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:20px;">

  <div style="background:#121923;border:1px solid ${isAlert ? 'rgba(255,107,107,0.4)' : '#1e2e3e'};border-radius:16px;padding:28px 24px;margin-bottom:16px;">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
      <div style="font-size:2.5rem;">🛡️</div>
      <div>
        <p style="margin:0;font-size:12px;color:#4a6080;text-transform:uppercase;letter-spacing:.06em;">EdgeIQ BrandGuard</p>
        <h1 style="margin:2px 0 0;font-size:1.15rem;color:#e8eef7;">${domain}</h1>
        <p style="margin:2px 0 0;font-size:12px;color:#9fb0c7;">${date}</p>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
      <div style="flex:1;min-width:70px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid ${suspicious.length > 0 ? 'rgba(255,107,107,0.4)' : '#1e2e3e'};">
        <div style="font-size:20px;font-weight:800;color:${suspicious.length > 0 ? '#ff6b6b' : '#3de19e'};">${suspicious.length}</div>
        <div style="font-size:11px;color:#9fb0c7;">Suspicious</div>
      </div>
      <div style="flex:1;min-width:70px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:${active.length > 0 ? '#ffb347' : '#3de19e'};">${active.length}</div>
        <div style="font-size:11px;color:#9fb0c7;">Active</div>
      </div>
      <div style="flex:1;min-width:70px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:#9fb0c7;">${registered.length}</div>
        <div style="font-size:11px;color:#9fb0c7;">Registered</div>
      </div>
      <div style="flex:1;min-width:70px;background:#0b0f14;border-radius:8px;padding:12px;text-align:center;border:1px solid #1e2e3e;">
        <div style="font-size:20px;font-weight:800;color:#9fb0c7;">${newDomains.length > 0 ? '+' + newDomains.length : '0'}</div>
        <div style="font-size:11px;color:#9fb0c7;">New this week</div>
      </div>
    </div>

    ${suspicious.length > 0 ? `
    <h2 style="font-size:12px;font-weight:700;color:#ff6b6b;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px;">🚨 Suspicious Lookalikes</h2>
    ${suspRow}` : ''}

    ${active.length > 0 ? `
    <h2 style="font-size:12px;font-weight:700;color:#ffb347;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 10px;">⚠️ Active (serving content)</h2>
    ${activeRow}` : ''}

    ${registered.length > 0 ? `
    <h2 style="font-size:12px;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 10px;">Registered (parked / no content)</h2>
    <div>${regRow}${registered.length > 8 ? `<span style="font-size:11px;color:#4a6080;"> +${registered.length - 8} more</span>` : ''}</div>` : ''}

    ${findings.length === 0 ? `
    <div style="text-align:center;padding:20px;">
      <div style="font-size:1.8rem;margin-bottom:8px;">✅</div>
      <p style="color:#3de19e;font-size:14px;font-weight:600;margin:0;">All clear — no active lookalike domains detected</p>
      <p style="color:#9fb0c7;font-size:12px;margin:6px 0 0;">We checked ${findings.length || 'all monitored'} variations. Nothing is registered or active.</p>
    </div>` : ''}
  </div>

  <div style="text-align:center;padding:12px 0 20px;">
    <a href="${siteUrl}/account/" style="display:inline-block;background:#f472b6;color:#071018;font-weight:700;font-size:13px;padding:11px 24px;border-radius:8px;text-decoration:none;">View BrandGuard Dashboard →</a>
    <p style="margin:12px 0 0;font-size:11px;color:#4a6080;">
      <a href="${siteUrl}/account/" style="color:#f472b6;">Manage subscription</a> ·
      <a href="mailto:support@edgeiqlabs.com" style="color:#4a6080;">support@edgeiqlabs.com</a>
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── Send email ────────────────────────────────────────────────────────────────

async function sendReport(env, email, domain, findings, newDomains, isAlertOnly = false) {
  if (!env.RESEND_API_KEY) return;
  const suspicious = findings.filter(f => f.suspicious).length;
  const active     = findings.filter(f => f.live).length;

  let subject;
  if (suspicious > 0)    subject = `🚨 BrandGuard Alert — ${suspicious} suspicious lookalike${suspicious > 1 ? 's' : ''} for ${domain}`;
  else if (newDomains.length > 0) subject = `⚠️ BrandGuard — ${newDomains.length} new lookalike${newDomains.length > 1 ? 's' : ''} registered for ${domain}`;
  else                   subject = `✅ BrandGuard Weekly — ${domain} looks clear`;

  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'alerts@edgeiqlabs.com',
      to: email,
      subject,
      html: buildAlertEmail(domain, findings, newDomains, siteUrl),
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

  const today     = new Date();
  const isMonday  = today.getUTCDay() === 1; // always email on Monday regardless of findings

  // List all BrandGuard subscribers
  let cursor, keys = [];
  do {
    const page = await env.PULSE_KV.list({ prefix: 'brandguard:', limit: 100, cursor });
    keys = keys.concat(page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  console.log(`BrandGuard cron: processing ${keys.length} subscribers (Monday=${isMonday})`);

  for (const { name } of keys) {
    try {
      const raw = await env.PULSE_KV.get(name);
      if (!raw) continue;
      const record = JSON.parse(raw);
      if (!record.active || !record.email || !record.domain) continue;

      const domain     = record.domain;
      const prevActive = new Set(record.known_active   || []);
      const prevSusp   = new Set(record.known_suspicious || []);

      // Generate variations and check DNS in batches
      const variants    = generateVariations(domain);
      const activeDomains = await checkDomainsInBatches(variants);

      // Content-check active domains (max 10 concurrent)
      const findings = [];
      const contentBatch = activeDomains.slice(0, 20); // cap content checks at 20
      const contentResults = await Promise.all(
        contentBatch.map(async v => {
          const c = await analyzeContent(v, domain);
          return { domain: v, ...c, suspicious: c.live && (c.mentionsBrand || c.hasCreditCard) };
        })
      );
      findings.push(...contentResults);
      // Add remaining active-but-not-content-checked as registered-only
      for (const v of activeDomains.slice(20)) {
        findings.push({ domain: v, live: false });
      }

      // Detect new entries vs previous scan
      const currentActive = new Set(activeDomains);
      const newDomains    = activeDomains.filter(v => !prevActive.has(v));
      const newSuspicious = findings.filter(f => f.suspicious && !prevSusp.has(f.domain));

      // Send email if: new findings, newly suspicious, or it's Monday (weekly digest)
      const shouldEmail = newDomains.length > 0 || newSuspicious.length > 0 || isMonday;
      if (shouldEmail) {
        await sendReport(env, record.email, domain, findings, newDomains);
      }

      // Update KV
      record.last_scan_at      = today.toISOString();
      record.known_active      = activeDomains;
      record.known_suspicious  = findings.filter(f => f.suspicious).map(f => f.domain);
      record.scan_count        = (record.scan_count || 0) + 1;
      record.last_findings_count = findings.length;

      await env.PULSE_KV.put(name, JSON.stringify(record), {
        metadata: { email: record.email, domain, last_scan_at: record.last_scan_at },
      });

      console.log(`BrandGuard: ${domain} → ${activeDomains.length} active, ${findings.filter(f => f.suspicious).length} suspicious`);
    } catch (err) {
      console.error(`Error processing ${name}:`, err.message);
    }
  }

  console.log('BrandGuard cron complete');
}
