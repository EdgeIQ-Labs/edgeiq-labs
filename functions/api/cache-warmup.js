/**
 * EdgeIQ Labs — Cache Warmer Pro (Server-Side)
 * Deploy as: Cloudflare Pages Function at /api/cache-warmup
 *
 * Premium tier: fetches sitemap server-side, warms URLs from CF edge network,
 * returns per-URL cache status with timing and colo analytics.
 * No CORS limits — reads full cf-cache-status / x-cache headers.
 *
 * License key validation deferred to Stage 2 (KV-backed).
 * For now: accepts any non-empty key header for testing.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-License-Key',
};

// Parse XML sitemap (handles <url><loc>...</loc></url> and <sitemap><loc>...</loc></sitemap>)
function parseSitemap(xml) {
  const urls = [];
  // Match <loc> tags inside <url> or <sitemapindex>
  const locRegex = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1].trim();
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Detect CDN from response headers
function detectCdn(headers) {
  if (headers.get('cf-cache-status')) return 'Cloudflare';
  if (headers.get('x-vercel-cache')) return 'Vercel';
  if (headers.get('x-fastly-cache') || headers.get('x-served-by')?.includes('cache')) return 'Fastly';
  if (headers.get('x-amz-cf-id')) return 'Amazon CloudFront';
  if (headers.get('x-akamai-transformed')) return 'Akamai';
  if (headers.get('server')?.toLowerCase().includes('bunny')) return 'BunnyCDN';
  return null;
}

// Extract cache status from CDN-specific headers
// Note: CF Pages Functions fetching external URLs don't always get cf-cache-status.
// Use cf-ray presence + timing heuristics as fallback.
function getCacheStatus(headers, elapsedMs) {
  // Cloudflare explicit status
  const cfStatus = headers.get('cf-cache-status');
  if (cfStatus) return cfStatus.toUpperCase();

  // Vercel
  const vercelStatus = headers.get('x-vercel-cache');
  if (vercelStatus) return vercelStatus.toUpperCase();

  // Fastly / Akamai / generic x-cache
  const xc = headers.get('x-cache');
  if (xc) {
    if (/hit/i.test(xc)) return 'HIT';
    if (/miss/i.test(xc)) return 'MISS';
    if (/expired/i.test(xc)) return 'EXPIRED';
    return xc.split(/[,;]/)[0].trim().toUpperCase();
  }

  // CloudFront
  if (headers.get('x-amz-cf-id')) {
    return xc?.includes('Hit') ? 'HIT' : 'MISS';
  }

  // bunny.net
  const bunny = headers.get('bunnycdn-cache-status');
  if (bunny) return bunny.toUpperCase();

  // Age header = cached
  const age = headers.get('age');
  if (age && parseInt(age) > 0) return 'HIT';

  // Fallback: if CF ray exists, we went through edge — use timing
  if (headers.get('cf-ray')) {
    if (elapsedMs < 150) return 'HIT';
    if (elapsedMs < 500) return 'WARM';
    return 'MISS';
  }

  // No CDN signals at all — still warmed via direct fetch
  if (elapsedMs < 200) return 'HIT';
  return 'WARM';
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // License key check (Stage 1: accept any non-empty key for testing)
  const licenseKey = request.headers.get('X-License-Key');
  if (!licenseKey || licenseKey.length < 8) {
    return new Response(JSON.stringify({
      error: 'Valid license key required',
      message: 'Cache Warmer Pro requires an active subscription.',
      upgradeUrl: 'https://buy.stripe.com/5kQ9AV2TF0SN8Ec7wA7wA47'
    }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  const { sitemapUrl, concurrency = 10, maxUrls = 500 } = body;
  if (!sitemapUrl) {
    return new Response(JSON.stringify({ error: 'sitemapUrl is required' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Validate URL
  try {
    new URL(sitemapUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid sitemap URL' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Step 1: Fetch and parse sitemap
  let sitemapXml;
  try {
    const sitemapResp = await fetch(sitemapUrl, {
      headers: { 'User-Agent': 'EdgeIQ-CacheWarmer/1.0 (+https://edgeiqlabs.com)' },
      redirect: 'follow',
    });
    if (!sitemapResp.ok) {
      return new Response(JSON.stringify({
        error: `Failed to fetch sitemap: HTTP ${sitemapResp.status}`,
        sitemapUrl
      }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
    sitemapXml = await sitemapResp.text();
  } catch (e) {
    return new Response(JSON.stringify({
      error: `Failed to fetch sitemap: ${e.message}`,
      sitemapUrl
    }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  let urls = parseSitemap(sitemapXml);
  if (urls.length === 0) {
    return new Response(JSON.stringify({
      error: 'No URLs found in sitemap',
      sitemapUrl,
      rawLength: sitemapXml.length
    }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Cap at maxUrls
  const totalFound = urls.length;
  if (urls.length > maxUrls) {
    urls = urls.slice(0, maxUrls);
  }

  // Step 2: Warm URLs concurrently from CF edge
  const results = [];
  const stats = { hit: 0, miss: 0, dynamic: 0, expired: 0, revalidated: 0, bypass: 0, error: 0, unknown: 0 };
  const cdnCounts = {};
  const colos = new Set();
  let totalMs = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(async (url) => {
      const start = Date.now();
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'EdgeIQ-CacheWarmer/1.0 (+https://edgeiqlabs.com)',
            'Accept': '*/*',
          },
          redirect: 'follow',
        });
        const elapsed = Date.now() - start;
        const cacheStatus = getCacheStatus(resp.headers, elapsed);
        const cdn = detectCdn(resp.headers);
        const colo = resp.headers.get('cf-ray') ? 'CF-EDGE' : null; // CF doesn't expose colo name directly

        if (colo) colos.add(colo);
        if (cdn) cdnCounts[cdn] = (cdnCounts[cdn] || 0) + 1;

        // Categorize
        const statusLower = cacheStatus.toLowerCase();
        if (statusLower === 'hit' || statusLower === 'revalidated') stats.hit++;
        else if (statusLower === 'miss' || statusLower === 'expired' || statusLower === 'warm' || statusLower === 'dynamic' || statusLower === 'bypass') stats.miss++;
        else stats.unknown++;

        totalMs += elapsed;

        return {
          url,
          status: resp.status,
          cacheStatus,
          cdn,
          elapsed,
          size: parseInt(resp.headers.get('content-length') || '0'),
          contentType: resp.headers.get('content-type') || '',
        };
      } catch (e) {
        stats.error++;
        return {
          url,
          status: 0,
          cacheStatus: 'ERROR',
          cdn: null,
          elapsed: Date.now() - start,
          error: e.message || 'Fetch failed',
        };
      }
    }));

    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ url: '?', status: 0, cacheStatus: 'ERROR', error: r.reason?.message });
    }
  }

  // Sort by elapsed desc (slowest first — most likely to benefit from warming)
  results.sort((a, b) => (b.elapsed || 0) - (a.elapsed || 0));

  const avgMs = results.length > 0 ? Math.round(totalMs / results.length) : 0;
  const primaryCdn = Object.entries(cdnCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return new Response(JSON.stringify({
    success: true,
    sitemapUrl,
    totalFound,
    warmed: results.length,
    truncated: totalFound > maxUrls,
    stats: {
      hit: stats.hit,
      miss: stats.miss,
      dynamic: stats.dynamic,
      expired: stats.expired,
      revalidated: stats.revalidated,
      bypass: stats.bypass,
      error: stats.error,
      unknown: stats.unknown,
    },
    avgResponseMs: avgMs,
    cdnDetected: primaryCdn,
    cdnBreakdown: cdnCounts,
    edgeLocations: colos.size,
    results,
    timestamp: new Date().toISOString(),
  }, null, 2), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

export async function onRequest(context) {
  return handleRequest(context.request);
}
