const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-UptimePing-Email',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function getSubscriber(env, email) {
  var raw = await env.PULSE_KV.get('uptimeping:sub:' + email);
  return raw ? JSON.parse(raw) : null;
}

async function putSubscriber(env, email, data) {
  await env.PULSE_KV.put('uptimeping:sub:' + email, JSON.stringify(data));
}

async function getMonitors(env, email) {
  var raw = await env.PULSE_KV.get('uptimeping:monitors:' + email);
  return raw ? JSON.parse(raw) : [];
}

async function putMonitors(env, email, monitors) {
  await env.PULSE_KV.put('uptimeping:monitors:' + email, JSON.stringify(monitors));
}

async function getState(env, email, urlHash) {
  var raw = await env.PULSE_KV.get('uptimeping:state:' + email + ':' + urlHash);
  return raw ? JSON.parse(raw) : null;
}

async function putState(env, email, urlHash, state) {
  await env.PULSE_KV.put('uptimeping:state:' + email + ':' + urlHash, JSON.stringify(state));
}

function hashUrl(url) {
  var h = 0;
  for (var i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// Inline uptime check
async function checkUrl(url) {
  var start = Date.now();
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 10000);
    var resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'EdgeIQ-UptimePing/1.0' },
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

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  
  var authEmail = (request.headers.get('X-UptimePing-Email') || '').trim().toLowerCase();
  if (!authEmail || !authEmail.includes('@')) return json({ error: 'Authentication required. Pass X-UptimePing-Email header.' }, 401);
  
  var subscriber = await getSubscriber(env, authEmail);
  if (!subscriber) {
    subscriber = { email: authEmail, stripe_customer_id: null, stripe_subscription_id: null, status: 'free', max_monitors: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await putSubscriber(env, authEmail, subscriber);
  }
  
  if (request.method === 'GET') {
    var monitors = await getMonitors(env, authEmail);
    // Enrich with current state
    var enriched = [];
    for (var i = 0; i < monitors.length; i++) {
      var m = monitors[i];
      var state = await getState(env, authEmail, hashUrl(m.url));
      enriched.push(Object.assign({}, m, state || { status: 'unknown', last_checked_at: null, response_time_ms: null }));
    }
    return json({ monitors: enriched, max_monitors: subscriber.max_monitors, count: monitors.length, status: subscriber.status });
  }
  
  if (request.method === 'POST') {
    var body = {};
    try { body = await request.json(); } catch(e) {}
    var url = (body.url || '').trim();
    var name = (body.name || '').trim();
    if (!url) return json({ error: 'URL required' }, 400);
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    try { new URL(url); } catch(e) { return json({ error: 'Invalid URL format' }, 400); }
    
    var monitors = await getMonitors(env, authEmail);
    if (monitors.length >= subscriber.max_monitors) return json({ error: 'Monitor limit reached (' + subscriber.max_monitors + '). Upgrade to add more.', upgrade_url: 'UPTIMEPING_CHECKOUT_URL_PLACEHOLDER' }, 403);
    if (monitors.some(function(m) { return m.url === url; })) return json({ error: 'URL already monitored' }, 409);
    
    // Initial check
    var checkResult = await checkUrl(url);
    var urlHash = hashUrl(url);
    var monitor = {
      url: url,
      name: name || url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      added_at: new Date().toISOString(),
      interval_ms: 300000, // 5 min default
      alert_email: authEmail,
    };
    monitors.push(monitor);
    await putMonitors(env, authEmail, monitors);
    
    // Save initial state
    await putState(env, authEmail, urlHash, {
      status: checkResult.status,
      http_status: checkResult.http_status,
      response_time_ms: checkResult.response_time_ms,
      last_checked_at: new Date().toISOString(),
      consecutive_failures: checkResult.status === 'down' ? 1 : 0,
    });
    
    return json({ success: true, monitor: monitor, check: checkResult }, 201);
  }
  
  if (request.method === 'DELETE') {
    var urlObj = new URL(request.url);
    var urlParam = (urlObj.searchParams.get('url') || '').trim();
    if (!urlParam) return json({ error: 'URL parameter required. Use ?url=https://example.com' }, 400);
    var targetUrl = decodeURIComponent(urlParam);
    var monitors = await getMonitors(env, authEmail);
    var filtered = monitors.filter(function(m) { return m.url !== targetUrl; });
    if (filtered.length === monitors.length) return json({ error: 'Monitor not found' }, 404);
    await putMonitors(env, authEmail, filtered);
    // Clean up state
    await env.PULSE_KV.delete('uptimeping:state:' + authEmail + ':' + hashUrl(targetUrl));
    return json({ success: true, removed: targetUrl });
  }
  
  return json({ error: 'Method not allowed' }, 405);
}
