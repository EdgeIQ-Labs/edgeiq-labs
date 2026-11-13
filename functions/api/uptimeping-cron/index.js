// UptimePing Cron — checks all monitored URLs, sends email alerts on state change
// Triggered by CF Pages cron: every 5 minutes
// OPTIMIZED for free tier: early-exit on no-change, KV queue for StatusPage incidents

async function getSubscriber(env, email) {
  var raw = await env.PULSE_KV.get('uptimeping:sub:' + email);
  return raw ? JSON.parse(raw) : null;
}

async function getMonitors(env, email) {
  var raw = await env.PULSE_KV.get('uptimeping:monitors:' + email);
  return raw ? JSON.parse(raw) : [];
}

async function getState(env, email, urlHash) {
  var raw = await env.PULSE_KV.get('uptimeping:state:' + email + ':' + urlHash);
  return raw ? JSON.parse(raw) : null;
}

async function putState(env, email, urlHash, state) {
  await env.PULSE_KV.put('uptimeping:state:' + email + ':' + urlHash, JSON.stringify(state));
}

async function getAlertDedup(env, email, urlHash, dateStr) {
  return await env.PULSE_KV.get('uptimeping:alerts:' + email + ':' + urlHash + ':' + dateStr);
}

async function setAlertDedup(env, email, urlHash, dateStr) {
  await env.PULSE_KV.put('uptimeping:alerts:' + email + ':' + urlHash + ':' + dateStr, '1', { expirationTtl: 86400 });
}

async function enqueueIncident(env, item) {
  var raw = await env.PULSE_KV.get('statuspage:incident-queue');
  var queue = raw ? JSON.parse(raw) : [];
  queue.push(item);
  // Cap queue at 100 items to prevent unbounded growth
  if (queue.length > 100) queue = queue.slice(-100);
  await env.PULSE_KV.put('statuspage:incident-queue', JSON.stringify(queue));
}

function hashUrl(url) {
  var h = 0;
  for (var i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function checkUrl(url) {
  var start = Date.now();
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);
    var resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'EdgeIQ-UptimePing-Cron/1.0' },
    });
    clearTimeout(timeout);
    var responseTime = Date.now() - start;
    var status = resp.status;
    var isUp = status >= 200 && status < 400;
    return { status: isUp ? 'up' : 'down', http_status: status, response_time_ms: responseTime };
  } catch (e) {
    return { status: 'down', http_status: 0, response_time_ms: Date.now() - start, error: e.name === 'AbortError' ? 'timeout' : 'connection_failed' };
  }
}

async function sendAlert(email, monitorName, monitorUrl, newStatus, responseTimeMs, resendKey) {
  var subject = newStatus === 'down'
    ? '🔴 DOWN: ' + monitorName + ' is unreachable'
    : '🟢 UP: ' + monitorName + ' is back online';
  var color = newStatus === 'down' ? '#ff6b6b' : '#3de19e';
  var emoji = newStatus === 'down' ? '🔴' : '🟢';
  var html = '<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;">' +
    '<h2 style="color:' + color + ';">' + emoji + ' ' + (newStatus === 'down' ? 'Site Down Alert' : 'Site Recovered') + '</h2>' +
    '<p><strong>Monitor:</strong> ' + monitorName + '</p>' +
    '<p><strong>URL:</strong> <a href="' + monitorUrl + '">' + monitorUrl + '</a></p>' +
    '<p><strong>Status:</strong> ' + newStatus.toUpperCase() + '</p>' +
    '<p><strong>Response Time:</strong> ' + responseTimeMs + 'ms</p>' +
    '<p><strong>Checked At:</strong> ' + new Date().toISOString() + '</p>' +
    '<hr style="border:none;border-top:1px solid #eee;margin:20px 0;">' +
    '<p style="color:#999;font-size:12px;">UptimePing by EdgeIQ Labs · <a href="https://edgeiqlabs.com/uptimeping/">Dashboard</a></p>' +
    '</div>';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'UptimePing <alerts@edgeiqlabs.com>',
        to: [email],
        subject: subject,
        html: html,
      }),
    });
  } catch (e) {
    console.error('Failed to send alert email:', e.message);
  }
}

export async function onRequest(context) {
  var env = context.env;
  var resendKey = env.RESEND_API_KEY || '';
  
  var subIndexRaw = await env.PULSE_KV.get('uptimeping:subscribers');
  var subscribers = subIndexRaw ? JSON.parse(subIndexRaw) : [];
  
  var results = [];
  var alertsSent = 0;
  var checksRun = 0;
  var incidentsQueued = 0;
  var skippedNoChange = 0;
  
  for (var s = 0; s < subscribers.length; s++) {
    var email = subscribers[s];
    var sub = await getSubscriber(env, email);
    if (!sub || sub.status !== 'active') continue;
    
    var monitors = await getMonitors(env, email);
    for (var i = 0; i < monitors.length; i++) {
      var m = monitors[i];
      checksRun++;
      var urlHash = hashUrl(m.url);
      var prevState = await getState(env, email, urlHash);
      var checkResult = await checkUrl(m.url);
      
      var newState = {
        status: checkResult.status,
        http_status: checkResult.http_status,
        response_time_ms: checkResult.response_time_ms,
        last_checked_at: new Date().toISOString(),
        consecutive_failures: checkResult.status === 'down'
          ? (prevState ? prevState.consecutive_failures + 1 : 1)
          : 0,
      };
      
      await putState(env, email, urlHash, newState);
      
      // EARLY EXIT: skip all alert/incident work if status unchanged
      var prevStatus = prevState ? prevState.status : 'unknown';
      if (prevStatus === checkResult.status) {
        skippedNoChange++;
        results.push({ email: email, url: m.url, status: checkResult.status, response_time_ms: checkResult.response_time_ms });
        continue;
      }
      
      // Skip first-ever check (no previous state to compare)
      if (prevStatus === 'unknown') {
        results.push({ email: email, url: m.url, status: checkResult.status, response_time_ms: checkResult.response_time_ms });
        continue;
      }
      
      // State changed — send alert
      var today = new Date().toISOString().slice(0, 10);
      var dedupKey = await getAlertDedup(env, email, urlHash, today);
      if (!dedupKey && resendKey) {
        await sendAlert(email, m.name || m.url, m.url, checkResult.status, checkResult.response_time_ms, resendKey);
        await setAlertDedup(env, email, urlHash, today);
        alertsSent++;
      }
      
      // Queue StatusPage incident (non-blocking, processed by separate cron)
      if (env.PULSE_KV) {
        try {
          await enqueueIncident(env, {
            owner_email: email,
            component_name: m.name || m.url,
            monitor_url: m.url,
            status: checkResult.status,
            response_time_ms: checkResult.response_time_ms,
            error: checkResult.error || null,
            queued_at: new Date().toISOString(),
          });
          incidentsQueued++;
        } catch (e) {
          console.error('Failed to queue incident:', e.message);
        }
      }
      
      results.push({ email: email, url: m.url, status: checkResult.status, response_time_ms: checkResult.response_time_ms });
    }
  }
  
  return new Response(JSON.stringify({
    cron: 'uptimeping',
    timestamp: new Date().toISOString(),
    checks_run: checksRun,
    skipped_no_change: skippedNoChange,
    alerts_sent: alertsSent,
    incidents_queued: incidentsQueued,
    results: results.slice(0, 50),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
