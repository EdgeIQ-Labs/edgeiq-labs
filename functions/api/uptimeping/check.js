const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Inline uptime check — HEAD request with timeout, no external API
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
    return {
      url: url,
      status: isUp ? 'up' : 'down',
      http_status: status,
      response_time_ms: responseTime,
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    var responseTime = Date.now() - start;
    var reason = e.name === 'AbortError' ? 'timeout' : (e.message || 'connection_failed');
    return {
      url: url,
      status: 'down',
      http_status: 0,
      response_time_ms: responseTime,
      error: reason,
      checked_at: new Date().toISOString(),
    };
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  
  var body = {};
  try { body = await context.request.json(); } catch(e) {}
  var url = (body.url || '').trim();
  if (!url) return json({ error: 'URL required' }, 400);
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  
  try { new URL(url); } catch(e) { return json({ error: 'Invalid URL format' }, 400); }
  
  var result = await checkUrl(url);
  return json(result);
}
