/**
 * EdgeIQ API Marketplace — Auth & Rate Limiting Middleware
 * Shared helper for all /api/v1/ endpoints.
 * Free tier (browser) is untouched — this only gates programmatic API access.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
};

// Rate limit tiers (requests per minute)
const RATE_LIMITS = {
  free: 10,
  pro: 100,
  enterprise: 1000,
};

/**
 * Validate API key and check rate limit.
 * Returns { valid, keyData, error } 
 */
export async function validateApiKey(request, env) {
  // Extract key from Authorization header or X-API-Key header
  const authHeader = request.headers.get('Authorization') || '';
  const apiKeyHeader = request.headers.get('X-API-Key') || '';
  
  let key = '';
  if (authHeader.startsWith('Bearer ')) {
    key = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    key = apiKeyHeader.trim();
  }

  if (!key) {
    return { valid: false, error: 'Missing API key. Use Authorization: Bearer <key> or X-API-Key header.', status: 401 };
  }

  if (!env.PULSE_KV) {
    return { valid: false, error: 'KV binding not available', status: 500 };
  }

  // Look up key in KV
  try {
    const keyData = await env.PULSE_KV.get(`apikey:${key}`, 'json');
    if (!keyData) {
      return { valid: false, error: 'Invalid API key', status: 401 };
    }

    // Check if revoked
    if (keyData.revoked) {
      return { valid: false, error: 'API key has been revoked', status: 403 };
    }

    // Check expiry
    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return { valid: false, error: 'API key has expired', status: 403 };
    }

    // Rate limiting — sliding window per minute
    const tier = keyData.tier || 'free';
    const limit = RATE_LIMITS[tier] || RATE_LIMITS.free;
    const now = Math.floor(Date.now() / 60000); // current minute bucket
    const rateKey = `ratelimit:${key}:${now}`;
    
    const currentCount = await env.PULSE_KV.get(rateKey, 'json') || 0;
    if (currentCount >= limit) {
      return { 
        valid: false, 
        error: `Rate limit exceeded. ${tier} tier allows ${limit} req/min.`, 
        status: 429,
        headers: { ...CORS_HEADERS, 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0', 'Retry-After': '60' }
      };
    }

    // Increment counter with 120s TTL (auto-cleanup)
    await env.PULSE_KV.put(rateKey, JSON.stringify(currentCount + 1), { expirationTtl: 120 });

    // Track total usage
    const usageKey = `apiusage:${key}:${new Date().toISOString().slice(0, 10)}`; // daily
    const dailyUsage = await env.PULSE_KV.get(usageKey, 'json') || 0;
    await env.PULSE_KV.put(usageKey, JSON.stringify(dailyUsage + 1), { expirationTtl: 2592000 }); // 30 days

    return { 
      valid: true, 
      keyData: { ...keyData, remaining: limit - currentCount - 1, limit },
      tier
    };
  } catch (e) {
    return { valid: false, error: `Auth error: ${e.message}`, status: 500 };
  }
}

/**
 * Standard JSON response helper
 */
export function apiResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders }
  });
}

/**
 * Handle OPTIONS preflight
 */
export function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export { CORS_HEADERS, RATE_LIMITS };
