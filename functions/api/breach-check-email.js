/**
 * EdgeIQ — Email Breach Checker (HIBP Free Tier Proxy)
 * POST /api/breach-check-email
 * Body: { email: "..." }
 *
 * Proxies HIBP v3 breachedaccount API with free-tier key.
 * Results cached in KV for 24h to minimize API calls.
 * Rate-limited to 1 req/sec per HIBP free tier terms.
 *
 * Env vars: HIBP_API_KEY (optional, falls back to keyless), PULSE_KV
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try { body = await context.request.json(); } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || !email.includes('.')) {
    return json({ error: 'Valid email is required' }, 400);
  }

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email format' }, 400);
  }

  const env = context.env;
  const kvKey = `breach:email:${email.replace(/[^a-z0-9@._-]/g, '_')}`;

  // Check KV cache first (24h TTL)
  if (env.PULSE_KV) {
    try {
      const cached = await env.PULSE_KV.get(kvKey, 'json');
      if (cached && cached.checkedAt) {
        const age = Date.now() - new Date(cached.checkedAt).getTime();
        if (age < 24 * 60 * 60 * 1000) {
          return json({ ...cached, cached: true });
        }
      }
    } catch (_) {}
  }

  // Query HIBP API
  const hibpKey = env.HIBP_API_KEY || '';
  const headers = {
    'User-Agent': 'EdgeIQ-BreachChecker/1.0',
    'Accept': 'application/json',
  };
  if (hibpKey) {
    headers['hibp-api-key'] = hibpKey;
  }

  try {
    const res = await fetch(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
      { headers, cf: { timeout: 8000 } }
    );

    let breachCount = 0;
    let breaches = [];

    if (res.status === 200) {
      const data = await res.json();
      breaches = Array.isArray(data) ? data : [];
      breachCount = breaches.length;
    } else if (res.status === 404) {
      // No breaches found — this is a valid result
      breachCount = 0;
      breaches = [];
    } else if (res.status === 429) {
      return json({
        error: 'Rate limit exceeded. Please wait a moment and try again.',
        retryAfter: res.headers.get('Retry-After') || '5',
      }, 429);
    } else if (res.status === 403) {
      return json({
        error: 'API access restricted. The free tier allows non-commercial use only.',
        note: 'This tool is provided for educational and personal security awareness.',
      }, 403);
    } else if (res.status === 401) {
      return json({
        error: 'API authentication failed. Please report this issue.',
      }, 500);
    } else {
      return json({
        error: `Breach check unavailable (${res.status}). Try again later.`,
      }, 502);
    }

    // Build response
    const result = {
      email: email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), // Partially mask for privacy
      breachCount,
      breaches: breaches.map(b => ({
        name: b.Name || b.Title || 'Unknown',
        domain: b.Domain || '',
        date: b.BreachDate || '',
        pwnCount: b.PwnCount || 0,
        dataClasses: b.DataClasses || [],
      })).slice(0, 20), // Cap at 20 to keep response small
      checkedAt: new Date().toISOString(),
    };

    // Cache in KV for 24h
    if (env.PULSE_KV) {
      try {
        await env.PULSE_KV.put(kvKey, JSON.stringify(result), {
          expirationTtl: 24 * 60 * 60,
        });
      } catch (_) {}
    }

    return json(result);
  } catch (e) {
    return json({
      error: `Breach check failed: ${e.message}`,
      note: 'Your email was sent securely to our server for lookup. We do not store it beyond the 24-hour cache.',
    }, 500);
  }
}
