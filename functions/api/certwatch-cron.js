/**
 * CertWatch Cron Handler
 * Runs daily at 6AM ET via CF Cron Trigger
 * Checks all monitored domains, sends alerts at 30/14/7/1 day thresholds
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'certwatch@edgeiqlabs.com';

async function sendAlert(email, domain, daysUntilExpiry, expiryDate) {
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
    return null; // No alert needed
  }

  const html = `
    <div style="font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef7;padding:32px;border-radius:12px;max-width:600px;margin:0 auto;">
      <h1 style="color:${urgency === 'CRITICAL' ? '#ff6b6b' : urgency === 'URGENT' ? '#ff8c42' : '#3dd9ff'};margin:0 0 16px;">${subject}</h1>
      <p style="color:#9fb0c7;font-size:16px;line-height:1.6;">
        The SSL certificate for <strong style="color:#e8eef7;">${domain}</strong> 
        ${daysUntilExpiry <= 0 ? 'has expired' : `expires in ${daysUntilExpiry} days`}.
      </p>
      <div style="background:#121923;border:1px solid #233142;border-radius:8px;padding:20px;margin:24px 0;">
        <div style="margin-bottom:12px;"><span style="color:#9fb0c7;">Expiry Date:</span> <strong style="color:#e8eef7;">${expiryDate}</strong></div>
        <div><span style="color:#9fb0c7;">Status:</span> <strong style="color:${urgency === 'CRITICAL' ? '#ff6b6b' : '#ffb347'};">${alertType.toUpperCase()}</strong></div>
      </div>
      <a href="https://edgeiqlabs.com/certwatch/" style="display:inline-block;background:#3dd9ff;color:#071018;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;margin-top:16px;">View Dashboard →</a>
      <p style="color:#4a6080;font-size:12px;margin-top:32px;">
        CertWatch by EdgeIQ Labs · SSL monitoring for $1/mo<br/>
        <a href="https://edgeiqlabs.com/certwatch/?unsubscribe=true" style="color:#4a6080;">Unsubscribe</a>
      </p>
    </div>
  `;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
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
      console.error(`Resend API error for ${email}: ${resp.status}`);
      return { success: false, error: `HTTP ${resp.status}` };
    }
    
    return { success: true, alertType };
  } catch (e) {
    console.error(`Failed to send alert to ${email}:`, e.message);
    return { success: false, error: e.message };
  }
}

export async function onRequest(context) {
  const { env } = context;
  
  // Get all active subscribers with monitored domains
  const subscribers = await env.DB.prepare(`
    SELECT DISTINCT s.id, s.email 
    FROM subscribers s 
    JOIN monitored_domains md ON s.id = md.subscriber_id 
    WHERE s.status = 'active'
  `).all();

  let totalChecked = 0;
  let totalAlerts = 0;
  let errors = [];

  for (const subscriber of subscribers.results) {
    // Get all domains for this subscriber
    const domains = await env.DB.prepare(
      'SELECT * FROM monitored_domains WHERE subscriber_id = ?'
    ).bind(subscriber.id).all();

    for (const domainRow of domains.results) {
      totalChecked++;
      
      // Check cert via existing SSL checker
      try {
        const checkResp = await fetch('https://edgeiqlabs.com/api/ssl-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: domainRow.domain }),
        });
        
        if (!checkResp.ok) {
          errors.push(`${domainRow.domain}: API returned ${checkResp.status}`);
          continue;
        }
        
        const checkData = await checkResp.json();
        
        if (checkData.error) {
          errors.push(`${domainRow.domain}: ${checkData.error}`);
          continue;
        }
        
        const expiryDate = checkData.expiry || checkData.validTo || checkData.notAfter;
        if (!expiryDate) {
          errors.push(`${domainRow.domain}: No expiry date in response`);
          continue;
        }
        
        const expiry = new Date(expiryDate);
        const now = new Date();
        const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        
        let status = 'valid';
        if (daysUntilExpiry <= 0) status = 'expired';
        else if (daysUntilExpiry <= 30) status = 'expiring_soon';
        
        // Update database
        await env.DB.prepare(
          'UPDATE monitored_domains SET last_checked_at = ?, last_expiry_date = ?, last_issuer = ?, last_status = ? WHERE id = ?'
        ).bind(
          now.toISOString(),
          expiry.toISOString(),
          checkData.issuer || checkData.organization || 'Unknown',
          status,
          domainRow.id
        ).run();
        
        // Check if we should send an alert
        const alertThresholds = [30, 14, 7, 1, 0];
        const shouldAlert = alertThresholds.some(t => daysUntilExpiry <= t && daysUntilExpiry > (t - 1));
        
        if (shouldAlert || daysUntilExpiry <= 0) {
          // Check if we already sent this alert type recently
          const recentAlert = await env.DB.prepare(
            'SELECT id FROM alert_history WHERE subscriber_id = ? AND domain = ? AND alert_type = ? AND sent_at > datetime("now", "-24 hours")'
          ).bind(subscriber.id, domainRow.domain, 
            daysUntilExpiry <= 0 ? 'expired' : 
            daysUntilExpiry <= 1 ? '1_day' : 
            daysUntilExpiry <= 7 ? '7_day' : 
            daysUntilExpiry <= 14 ? '14_day' : '30_day'
          ).first();
          
          if (!recentAlert) {
            const alertResult = await sendAlert(
              subscriber.email, 
              domainRow.domain, 
              daysUntilExpiry, 
              expiry.toISOString().split('T')[0]
            );
            
            if (alertResult?.success) {
              totalAlerts++;
              
              // Record alert
              await env.DB.prepare(
                'INSERT INTO alert_history (subscriber_id, domain, alert_type, expiry_date) VALUES (?, ?, ?, ?)'
              ).bind(
                subscriber.id,
                domainRow.domain,
                alertResult.alertType,
                expiry.toISOString()
              ).run();
            }
          }
        }
        
      } catch (e) {
        errors.push(`${domainRow.domain}: ${e.message}`);
      }
      
      // Rate limit: don't hammer the SSL checker API
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return new Response(JSON.stringify({
    success: true,
    checked: totalChecked,
    alerts_sent: totalAlerts,
    errors: errors.length,
    error_details: errors.slice(0, 10), // First 10 errors only
    timestamp: new Date().toISOString(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
