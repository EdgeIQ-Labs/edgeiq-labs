/**
 * EdgeIQ Labs — Rate Watch: Cron-triggered rate checker
 * GET /api/rate-watch/check (triggered by cron every 6 hours)
 * Scrapes Fed H.15 release for prime rate, compares to stored value,
 * sends email alerts via Resend if changed.
 */

export async function onRequest(context) {
  const { request, env } = context;

  // Only allow GET (cron triggers use GET)
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Scrape Federal Reserve H.15 page for prime rate
    const fedResp = await fetch('https://www.federalreserve.gov/releases/h15/', {
      headers: {
        'User-Agent': 'EdgeIQ-RateWatch/1.0 (monitoring service)',
        'Accept': 'text/html',
      },
      cf: { timeout: 15000 },
    });

    if (!fedResp.ok) {
      return new Response(JSON.stringify({ error: 'Failed to fetch Fed data', status: fedResp.status }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const html = await fedResp.text();

    // Parse prime rate from H.15 page
    // The prime rate appears in a table row like: "Prime rate" followed by a percentage
    // Pattern varies but typically: "Bank prime rate" or "Prime rate" with value like "7.50"
    const primeRateMatch = html.match(/(?:bank\s+)?prime\s+rate[\s\S]*?(\d+\.\d+)/i)
      || html.match(/(\d+\.\d+)[\s\S]*?prime\s+rate/i)
      || html.match(/class="[^"]*"[^>]*>(\d+\.\d+)<\/td>[\s\S]{0,200}prime/i);

    if (!primeRateMatch) {
      // Try alternative parsing - look for the data table
      const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi);
      if (tableMatch) {
        for (const table of tableMatch) {
          const rateInTable = table.match(/prime[\s\S]{0,500}?(\d+\.\d+)/i);
          if (rateInTable) {
            var currentRate = parseFloat(rateInTable[1]);
            break;
          }
        }
      }
    } else {
      var currentRate = parseFloat(primeRateMatch[1]);
    }

    if (!currentRate || currentRate < 1 || currentRate > 30) {
      return new Response(JSON.stringify({ error: 'Could not parse valid prime rate from Fed page' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get last known rate
    const lastKnown = await env.RATE_WATCH_KV.get('prime_rate_current', 'json');
    const previousRate = lastKnown ? lastKnown.rate : null;

    // If no change, log and exit
    if (previousRate === currentRate) {
      return new Response(JSON.stringify({
        checked: true,
        rate: currentRate,
        changed: false,
        message: 'No rate change detected',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Rate changed! Calculate delta
    const delta = currentRate - (previousRate || 0);
    const direction = delta > 0 ? 'increased' : 'decreased';
    const changeAmount = Math.abs(delta).toFixed(2);
    const now = new Date().toISOString();

    // Update stored rate
    await env.RATE_WATCH_KV.put('prime_rate_current', JSON.stringify({
      rate: currentRate,
      updated_at: now,
      previous_rate: previousRate,
    }));

    // Log to history
    const dateKey = now.split('T')[0];
    await env.RATE_WATCH_KV.put(`rate_history:${dateKey}`, JSON.stringify({
      rate: currentRate,
      previous_rate: previousRate,
      delta,
      timestamp: now,
    }));

    // Get all active subscribers
    const index = await env.RATE_WATCH_KV.get('subscribers_index', 'json') || [];
    let emailsSent = 0;
    let errors = [];

    for (const email of index) {
      const sub = await env.RATE_WATCH_KV.get(`sub:${email}`, 'json');
      if (!sub || sub.status !== 'active') continue;

      // Build unsubscribe token
      const unsubToken = btoa(email);
      const unsubUrl = `https://edgeiqlabs.com/api/rate-watch/unsubscribe?token=${unsubToken}`;

      // Build email HTML
      const emailHtml = buildEmailHtml(currentRate, previousRate, delta, unsubUrl);

      // Send via Resend
      try {
        const resendResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Rate Watch <alerts@edgeiqlabs.com>',
            to: [email],
            subject: `🔔 Prime Rate ${direction}: Now ${currentRate.toFixed(2)}%`,
            html: emailHtml,
          }),
        });

        if (resendResp.ok) {
          emailsSent++;
        } else {
          const errText = await resendResp.text();
          errors.push({ email, error: errText });
        }
      } catch (err) {
        errors.push({ email, error: err.message });
      }
    }

    return new Response(JSON.stringify({
      checked: true,
      rate: currentRate,
      previous_rate: previousRate,
      changed: true,
      delta,
      emails_sent: emailsSent,
      errors: errors.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function buildEmailHtml(currentRate, previousRate, delta, unsubUrl) {
  const direction = delta > 0 ? 'increased' : 'decreased';
  const arrow = delta > 0 ? '↑' : '↓';
  const changeColor = delta > 0 ? '#ff6b7a' : '#3de19e';
  const changeAmt = Math.abs(delta).toFixed(2);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:Inter,system-ui,-apple-system,sans-serif;color:#e8eef7;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#3dd9ff;margin:0 0 8px;">EdgeIQ Rate Watch</h1>
    <h2 style="font-size:28px;font-weight:900;margin:0;color:#fff;">Prime Rate Alert</h2>
  </div>

  <div style="background:#121923;border:1px solid #233142;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <p style="font-size:14px;color:#9fb0c7;margin:0 0 8px;">The Federal Reserve prime rate has ${direction}</p>
    <div style="font-size:48px;font-weight:900;color:#fff;margin:16px 0;">
      ${currentRate.toFixed(2)}%
    </div>
    <div style="font-size:18px;font-weight:700;color:${changeColor};">
      ${arrow} ${changeAmt}% from ${previousRate ? previousRate.toFixed(2) + '%' : 'previous'}
    </div>
  </div>

  <div style="background:#121923;border:1px solid #233142;border-radius:12px;padding:24px;margin-bottom:24px;">
    <h3 style="font-size:16px;font-weight:700;margin:0 0 12px;color:#fff;">What this means for you</h3>
    <p style="font-size:14px;line-height:1.6;color:#b8cce0;margin:0;">
      Your variable APR credit cards likely repriced within 1-2 billing cycles. 
      A ${changeAmt}% prime rate change typically translates to the same change on your card's APR. 
      Check your next statement for the updated rate.
    </p>
  </div>

  <div style="text-align:center;margin-top:32px;">
    <a href="https://edgeiqlabs.com/rate-watch/" style="display:inline-block;padding:12px 24px;background:#3dd9ff;color:#071018;font-weight:700;border-radius:8px;text-decoration:none;font-size:14px;">View Rate History</a>
  </div>

  <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid #233142;">
    <p style="font-size:12px;color:#6b7f99;margin:0 0 8px;">Informational only. Not financial advice.</p>
    <p style="font-size:12px;color:#6b7f99;margin:0;">
      <a href="${unsubUrl}" style="color:#6b7f99;text-decoration:underline;">Unsubscribe from alerts</a>
    </p>
    <p style="font-size:11px;color:#4a6080;margin:12px 0 0;">© 2026 EdgeIQ Labs</p>
  </div>
</div>
</body>
</html>`;
}
