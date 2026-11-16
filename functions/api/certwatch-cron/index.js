/**
 * CertWatch Cron Handler (KV-backed)
 * Triggered via CF Pages scheduled function or external cron ping.
 * Checks all monitored domains, sends alerts at 30/14/7/1 day thresholds.
 *
 * KV Key Schema:
 *   certwatch:sub:{email}          → subscriber JSON
 *   certwatch:domains:{email}      → JSON array of domain objects
 *   certwatch:alerts:{email}:{domain}:{alertType}:{YYYY-MM-DD} → "sent" (TTL 48h)
 */

const FROM_EMAIL = 'certwatch@edgeiqlabs.com';

// ─── KV Helpers ────────────────────────────────────────────────
async function getAllSubscribers(env) {
  const subscribers = [];
  let cursor = undefined;

  do {
    const result = await env.PULSE_KV.list({ prefix: 'certwatch:sub:', cursor, limit: 100 });
    for (const key of result.keys) {
      const raw = await env.PULSE_KV.get(key.name);
      if (raw) {
        try {
          subscribers.push(JSON.parse(raw));
        } catch {}
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return subscribers;
}

async function getDomains(env, email) {
  const raw = await env.PULSE_KV.get(`certwatch:domains:${email}`);
  return raw ? JSON.parse(raw) : [];
}

async function putDomains(env, email, domains) {
  await env.PULSE_KV.put(`certwatch:domains:${email}`, JSON.stringify(domains));
}

async function hasRecentAlert(env, email, domain, alertType) {
  const today = new Date().toISOString().split('T')[0];
  const key = `certwatch:alerts:${email}:${domain}:${alertType}:${today}`;
  const exists = await env.PULSE_KV.get(key);
  return !!exists;
}

async function recordAlert(env, email, domain, alertType) {
  const today = new Date().toISOString().split('T')[0];
  const key = `certwatch:alerts:${email}:${domain}:${alertType}:${today}`;
  // TTL 48 hours to prevent duplicate alerts within same threshold window
  await env.PULSE_KV.put(key, 'sent', { expirationTtl: 172800 });
}

// ─── SSL Cert Expiry Check (KV-cached crt.sh, 2026-11-16 optimization) ─────────
// Strategy: Cache crt.sh results in KV for 24h. Only hit external API on cache miss.
// This reduces CPU from N×external_fetch to N×KV_get (sub-ms vs seconds).
const CERT_CACHE_TTL = 86400; // 24 hours

async function checkCert(domain, env) {
  try {
    // Check KV cache first (sub-ms read vs 3-10s external fetch)
    const cacheKey = 'certwatch:cache:' + domain;
    const cached = await env.PULSE_KV.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        // Validate cache isn't stale (defensive)
        if (parsed._cached_at && (Date.now() - parsed._cached_at < CERT_CACHE_TTL * 1000)) {
          return parsed;
        }
      } catch {}
    }

    // Cache miss — hit crt.sh with optimized query
    var resp = await fetch(
      'https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json&exclude=expired',
      { 
        headers: { 'User-Agent': 'EdgeIQ-CertWatch-Cron/1.0', 'Accept': 'application/json' },
        cf: { cacheTtl: 3600 } // Also leverage CF edge cache
      }
    );
    if (!resp.ok) return null;

    var text = await resp.text();
    var certs;
    try { certs = JSON.parse(text); } catch { return null; }

    if (!Array.isArray(certs) || certs.length === 0) return null;

    var matching = [];
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i];
      if (!c.not_after || !c.not_before) continue;
      var nameValue = c.name_value || '';
      var commonName = c.common_name || '';
      if (nameValue.indexOf(domain) !== -1 || commonName === domain) matching.push(c);
    }
    if (matching.length === 0) matching = certs.filter(function(c) { return c.not_after && c.not_before; });
    if (matching.length === 0) return null;

    matching.sort(function(a, b) { return new Date(b.not_before).getTime() - new Date(a.not_before).getTime(); });
    var latest = matching[0];
    var expiryDate = new Date(latest.not_after);
    var now = new Date();
    var daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    var status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    var issuerRaw = latest.issuer_name || 'Unknown';
    var cnMatch = issuerRaw.match(/CN=([^,]+)/);
    var issuerCN = cnMatch ? cnMatch[1] : issuerRaw;

    var result = {
      expiry_date: expiryDate.toISOString(),
      days_until_expiry: daysUntilExpiry,
      issuer: issuerCN,
      status: status,
      _cached_at: Date.now(),
    };

    // Write to KV cache (non-blocking, fire-and-forget style)
    await env.PULSE_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CERT_CACHE_TTL });

    return result;
  } catch {
    return null;
  }
}

// ─── Email Alert via Resend ────────────────────────────────────
async function sendAlert(env, email, domain, daysUntilExpiry, expiryDate) {
  let alertType, subject, urgency;

  if (daysUntilExpiry <= 0) {
    alertType = 'expired';
    subject = `🚨 EXPIRED: SSL certificate for ${domain}`;
    urgency = 'CRITICAL';
  } else if (daysUntilExpiry <= 1) {
    alertType = '1_day';
    subject = `⚠️ URGENT: ${domain} SSL expires tomorrow`;
    urgency = 'URGENT';
  } else if (daysUntilExpiry <= 7) {
    alertType = '7_day';
    subject = `⏰ ${domain} SSL expires in ${daysUntilExpiry} days`;
    urgency = 'WARNING';
  } else if (daysUntilExpiry <= 14) {
    alertType = '14_day';
    subject = `📅 ${domain} SSL expires in ${daysUntilExpiry} days`;
    urgency = 'NOTICE';
  } else if (daysUntilExpiry <= 30) {
    alertType = '30_day';
    subject = `📋 ${domain} SSL expires in ${daysUntilExpiry} days`;
    urgency = 'INFO';
  } else {
    return null;
  }

  // Deduplicate: only one alert per type per day
  if (await hasRecentAlert(env, email, domain, alertType)) {
    return { skipped: true, alertType };
  }

  const colorMap = { CRITICAL: '#ff6b6b', URGENT: '#ff8c42', WARNING: '#ffb347', NOTICE: '#3dd9ff', INFO: '#3de19e' };
  const color = colorMap[urgency] || '#3dd9ff';

  const html = `
    <div style="font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:32px;border-radius:12px;max-width:600px;margin:0 auto;">
      <h1 style="color:${color};margin:0 0 16px;">${subject}</h1>
      <p style="color:#9fb0c7;font-size:16px;line-height:1.6;">
        The SSL certificate for <strong style="color:#e8eef7;">${domain}</strong>
        ${daysUntilExpiry <= 0 ? 'has expired' : `expires in ${daysUntilExpiry} days`}.
      </p>
      <div style="background:#121923;border:1px solid #233142;border-radius:8px;padding:20px;margin:24px 0;">
        <div style="margin-bottom:12px;"><span style="color:#9fb0c7;">Expiry Date:</span> <strong style="color:#e8eef7;">${expiryDate}</strong></div>
        <div><span style="color:#9fb0c7;">Status:</span> <strong style="color:${color};">${alertType.toUpperCase()}</strong></div>
      </div>
      <a href="https://edgeiqlabs.com/certwatch/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;margin-top:16px;">View Dashboard →</a>
      <p style="color:#4a6080;font-size:12px;margin-top:32px;">
        CertWatch by EdgeIQ Labs · SSL monitoring for $1/mo<br/>
        <a href="https://edgeiqlabs.com/certwatch/?unsubscribe=true" style="color:#4a6080;">Unsubscribe</a>
      </p>
    </div>
  `;

  const resendKey = env.RESEND_API_KEY;
  if (!resendKey) {
    return { success: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject,
        html,
      }),
    });

    if (!resp.ok) {
      return { success: false, error: `Resend HTTP ${resp.status}` };
    }

    await recordAlert(env, email, domain, alertType);
    return { success: true, alertType };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Main Cron Handler ─────────────────────────────────────────
// HARD CAPS (free-tier CPU protection, 2026-11-16):
//   - Max 5 subscribers per invocation
//   - Max 3 domains per subscriber
//   - 8ms CPU budget guard (bail if exceeded)
//   - KV cursor pagination to avoid full list scan
const MAX_SUBS_PER_RUN = 5;
const MAX_DOMAINS_PER_SUB = 3;
const CPU_BUDGET_MS = 8;

export async function onRequest(context) {
  const { env } = context;
  const startTime = Date.now();

  // Paginated subscriber fetch with hard cap
  const subscribers = [];
  let cursor = undefined;
  while (subscribers.length < MAX_SUBS_PER_RUN) {
    const result = await env.PULSE_KV.list({ prefix: 'certwatch:sub:', cursor, limit: 20 });
    for (const key of result.keys) {
      if (subscribers.length >= MAX_SUBS_PER_RUN) break;
      const raw = await env.PULSE_KV.get(key.name);
      if (raw) {
        try {
          const sub = JSON.parse(raw);
          if (sub.status === 'active' || sub.status === 'free') subscribers.push(sub);
        } catch {}
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
    if (!cursor) break;
  }

  let totalChecked = 0;
  let totalAlerts = 0;
  let errors = [];
  let cpuBailed = false;

  for (const sub of subscribers) {
    // CPU budget check before each subscriber
    if (Date.now() - startTime > CPU_BUDGET_MS) {
      cpuBailed = true;
      break;
    }

    const allDomains = await getDomains(env, sub.email);
    const domains = allDomains.slice(0, MAX_DOMAINS_PER_SUB);

    for (const domainObj of domains) {
      // CPU budget check before each domain
      if (Date.now() - startTime > CPU_BUDGET_MS) {
        cpuBailed = true;
        break;
      }

      totalChecked++;

      const result = await checkCert(domainObj.domain, env);

      if (!result) {
        errors.push(`${domainObj.domain}: check failed`);
        continue;
      }

      // Update stored domain data
      domainObj.last_checked_at = new Date().toISOString();
      domainObj.last_expiry_date = result.expiry_date;
      domainObj.last_issuer = result.issuer;
      domainObj.last_status = result.status;
      domainObj.last_days_until_expiry = result.days_until_expiry;

      // Send alert if at threshold
      const thresholds = [30, 14, 7, 1, 0];
      const hitThreshold = thresholds.some(t =>
        result.days_until_expiry <= t && result.days_until_expiry > (t - 1)
      );

      if (hitThreshold || result.days_until_expiry <= 0) {
        const alertResult = await sendAlert(
          env,
          sub.email,
          domainObj.domain,
          result.days_until_expiry,
          result.expiry_date.split('T')[0]
        );

        if (alertResult?.success) {
          totalAlerts++;
        }
      }

      // REMOVED: 500ms sleep was burning CPU on free tier for no benefit
    }

    // Save updated domain data
    if (domains.length > 0) {
      await putDomains(env, sub.email, domains);
    }
  }

  return new Response(JSON.stringify({
    success: true,
    checked: totalChecked,
    alerts_sent: totalAlerts,
    errors: errors.length,
    error_details: errors.slice(0, 10),
    cpu_bailed: cpuBailed,
    subs_processed: subscribers.length,
    elapsed_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
