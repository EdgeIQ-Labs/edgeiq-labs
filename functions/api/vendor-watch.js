/**
 * GET /api/vendor-watch
 * Fetches live status for ~14 major SaaS vendors concurrently.
 * Cached at the CF edge for 3 minutes to avoid hammering vendor APIs.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VENDORS = [
  // Statuspage.io format: status.indicator = none|minor|major|critical
  { id: 'stripe',     name: 'Stripe',       emoji: '💳', category: 'Payments',      url: 'https://www.stripestatus.com/api/v2/status.json',       fmt: 'sp' },
  { id: 'cloudflare', name: 'Cloudflare',   emoji: '🌐', category: 'Infrastructure', url: 'https://www.cloudflarestatus.com/api/v2/status.json',   fmt: 'sp' },
  { id: 'github',     name: 'GitHub',       emoji: '🐙', category: 'Dev Tools',      url: 'https://www.githubstatus.com/api/v2/status.json',       fmt: 'sp' },
  { id: 'vercel',     name: 'Vercel',       emoji: '▲',  category: 'Hosting',        url: 'https://www.vercel-status.com/api/v2/status.json',      fmt: 'sp' },
  { id: 'netlify',    name: 'Netlify',      emoji: '🔷', category: 'Hosting',        url: 'https://www.netlifystatus.com/api/v2/status.json',      fmt: 'sp' },
  { id: 'shopify',    name: 'Shopify',      emoji: '🛒', category: 'Commerce',       url: 'https://www.shopifystatus.com/api/v2/status.json',      fmt: 'sp' },
  { id: 'twilio',     name: 'Twilio',       emoji: '📞', category: 'Comms',          url: 'https://status.twilio.com/api/v2/status.json',          fmt: 'sp' },
  { id: 'sendgrid',   name: 'SendGrid',     emoji: '📧', category: 'Email',          url: 'https://status.sendgrid.com/api/v2/status.json',        fmt: 'sp' },
  { id: 'hubspot',    name: 'HubSpot',      emoji: '🧲', category: 'CRM',            url: 'https://status.hubspot.com/api/v2/status.json',         fmt: 'sp' },
  { id: 'intercom',   name: 'Intercom',     emoji: '💬', category: 'Support',        url: 'https://www.intercomstatus.com/api/v2/status.json',     fmt: 'sp' },
  { id: 'datadog',    name: 'Datadog',      emoji: '📊', category: 'Monitoring',     url: 'https://status.datadoghq.com/api/v2/status.json',       fmt: 'sp' },
  { id: 'newrelic',   name: 'New Relic',    emoji: '📈', category: 'Monitoring',     url: 'https://status.newrelic.com/api/v2/status.json',        fmt: 'sp' },
  { id: 'mongodb',    name: 'MongoDB Atlas',emoji: '🍃', category: 'Database',       url: 'https://status.mongodb.com/api/v2/status.json',         fmt: 'sp' },
  // Slack uses their own format
  { id: 'slack',      name: 'Slack',        emoji: '💼', category: 'Comms',          url: 'https://slack-status.com/api/v2.0.0/current',           fmt: 'slack' },
];

function normalizeStatuspage(data) {
  const ind = data?.status?.indicator;
  if (ind === 'none')     return { status: 'operational', description: 'All systems operational' };
  if (ind === 'minor')    return { status: 'degraded',    description: data.status.description || 'Minor degradation' };
  if (ind === 'major')    return { status: 'outage',      description: data.status.description || 'Major outage' };
  if (ind === 'critical') return { status: 'outage',      description: data.status.description || 'Critical incident' };
  return { status: 'unknown', description: 'Status unavailable' };
}

function normalizeSlack(data) {
  if (data?.status === 'ok' && !data?.active_incidents?.length) {
    return { status: 'operational', description: 'All systems operational' };
  }
  if (data?.active_incidents?.length) {
    return { status: 'degraded', description: data.active_incidents[0]?.title || 'Active incident' };
  }
  return { status: 'unknown', description: 'Status unavailable' };
}

async function fetchVendor(vendor) {
  try {
    const resp = await fetch(vendor.url, {
      headers: { 'User-Agent': 'EdgeIQ-VendorWatch/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return { ...vendor, status: 'unknown', description: 'Status page unreachable' };
    const data = await resp.json();
    const normalized = vendor.fmt === 'slack' ? normalizeSlack(data) : normalizeStatuspage(data);
    return { ...vendor, ...normalized, checked_at: new Date().toISOString() };
  } catch {
    return { ...vendor, status: 'unknown', description: 'Could not reach status page', checked_at: new Date().toISOString() };
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  // 3-minute edge cache
  const cache = caches.default;
  const cacheKey = new Request('https://edgeiq-vendor-watch-v2/all', { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
  }

  const results = await Promise.all(VENDORS.map(fetchVendor));

  const payload = JSON.stringify({
    vendors: results,
    checked_at: new Date().toISOString(),
    total: results.length,
    operational: results.filter(v => v.status === 'operational').length,
    issues: results.filter(v => v.status !== 'operational' && v.status !== 'unknown').length,
  });

  const response = new Response(payload, {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=180',
      'X-Cache': 'MISS',
    },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}
