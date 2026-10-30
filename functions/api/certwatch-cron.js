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

// ─── SSL Check ─────────────────────────────────────────────────
async function checkCert(domain) {
  try {
    const resp = await fetch('https://edgeiqlabs.com/api/ssl-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    if (data.error) return null;

    const expiryDate = data.expiry || data.validTo || data.notAfter;
    if (!expiryDate) return null;

    const expiry = new Date(expiryDate);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    let status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    return {
      expiry_date: expiry.toISOString(),
      days_until_expiry: daysUntilExpiry,
      issuer: data.issuer || data.organization || 'Unknown',
      status,
    };
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
export async function onRequest(context) {
  const { env } = context;

  const subscribers = await getAllSubscribers(env);
  const activeSubs = subscribers.filter(s => s.status === 'active' || s.status === 'free');

  let totalChecked = 0;
  let totalAlerts = 0;
  let errors = [];

  for (const sub of activeSubs) {
    const domains = await getDomains(env, sub.email);

    for (const domainObj of domains) {
      totalChecked++;

      const result = await checkCert(domainObj.domain);

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

      // Rate limit between checks
      await new Promise(r => setTimeout(r, 500));
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
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
