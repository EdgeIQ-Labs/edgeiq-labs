/**
 * EdgeIQ API Marketplace — Key Management
 * POST /api/api-keys — Generate new API key (after Stripe checkout)
 * GET /api/api-keys?key=xxx — Check key status and usage
 */

import { validateApiKey, apiResponse, handleOptions, CORS_HEADERS } from './_apimarket.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { email, tier } = body;

      if (!email || !email.includes('@')) {
        return apiResponse({ error: 'Valid email required' }, 400);
      }

      const keyTier = tier || 'pro';

      // Generate unique API key
      const raw = crypto.randomUUID().replace(/-/g, '');
      const key = `eiq_live_${raw.slice(0, 24)}`;

      const keyData = {
        key,
        email,
        tier: keyTier,
        created_at: new Date().toISOString(),
        expires_at: null, // No expiry for subscription keys — webhook handles revocation
        revoked: false,
      };

      // Store in KV
      await env.PULSE_KV.put(`apikey:${key}`, JSON.stringify(keyData));

      // Also index by email for lookup
      const existingKeys = await env.PULSE_KV.get(`apikeys_by_email:${email}`, 'json') || [];
      existingKeys.push(key);
      await env.PULSE_KV.put(`apikeys_by_email:${email}`, JSON.stringify(existingKeys));

      return apiResponse({
        ok: true,
        key,
        tier: keyTier,
        message: 'API key generated. Keep it secret — it cannot be retrieved again.',
        docs_url: 'https://edgeiqlabs.com/developers/docs/'
      });
    } catch (e) {
      return apiResponse({ error: e.message }, 500);
    }
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const keyParam = url.searchParams.get('key');

    if (!keyParam) {
      return apiResponse({ error: 'Missing ?key= parameter' }, 400);
    }

    try {
      const keyData = await env.PULSE_KV.get(`apikey:${keyParam}`, 'json');
      if (!keyData) {
        return apiResponse({ error: 'Key not found' }, 404);
      }

      // Get today's usage
      const today = new Date().toISOString().slice(0, 10);
      const usage = await env.PULSE_KV.get(`apiusage:${keyParam}:${today}`, 'json') || 0;

      return apiResponse({
        tier: keyData.tier,
        email: keyData.email,
        created_at: keyData.created_at,
        revoked: keyData.revoked,
        requests_today: usage,
      });
    } catch (e) {
      return apiResponse({ error: e.message }, 500);
    }
  }

  return apiResponse({ error: 'Method not allowed' }, 405);
}
