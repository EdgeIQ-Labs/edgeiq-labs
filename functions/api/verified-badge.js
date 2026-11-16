/**
 * EdgeIQ Verified Badge API
 * GET /api/verified-badge?id=<badge_id> — public badge data for embed rendering
 * POST /api/verified-badge — create/update badge record (called by webhook + dashboard)
 * PUT /api/verified-badge — update logo/embed settings (auth required via api_key param)
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // GET — public badge data for embed script OR email lookup for dashboard login
  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    // Email lookup: ?id=email:user@example.com → returns badge data
    if (id.startsWith('email:')) {
      const email = id.slice(6).trim().toLowerCase();
      const badgeId = await env.PULSE_KV.get(`vbadge:email:${email}`);
      if (!badgeId) {
        return new Response(JSON.stringify({ error: 'No badge found for that email' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      const data = await env.PULSE_KV.get(`vbadge:${badgeId}`, 'json');
      if (!data) {
        return new Response(JSON.stringify({ error: 'Badge record missing' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
    const data = await env.PULSE_KV.get(`vbadge:${id}`, 'json');
    if (!data) {
      return new Response(JSON.stringify({ error: 'Badge not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: data.id,
      domain: data.domain,
      company: data.company || '',
      logo: data.logo || null,
      verified_at: data.verified_at,
      expires_at: data.expires_at,
      status: data.status || 'active',
      verification_url: `https://edgeiqlabs.com/badge/verify/${id}/`,
    }), {
      headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
  }

  // POST — create badge record (webhook or manual)
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { domain, email, customerId, subscriptionId, company } = body;
      if (!domain || !email) {
        return new Response(JSON.stringify({ error: 'domain and email required' }), { status: 400, headers: CORS });
      }

      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const now = new Date();
      const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

      const badgeData = {
        id,
        domain,
        email,
        customerId: customerId || null,
        subscriptionId: subscriptionId || null,
        company: company || '',
        logo: null,
        verified_at: now.toISOString(),
        expires_at: expires.toISOString(),
        status: 'active',
      };

      // Store by badge ID
      await env.PULSE_KV.put(`vbadge:${id}`, JSON.stringify(badgeData));
      // Index by domain
      await env.PULSE_KV.put(`vbadge:domain:${domain}`, id);
      // Index by email
      await env.PULSE_KV.put(`vbadge:email:${email}`, id);
      // Index by Stripe customer
      if (customerId) {
        await env.PULSE_KV.put(`vbadge:stripe:${customerId}`, id);
      }

      const embedCode = `<script src="https://edgeiqlabs.com/verified-badge.js" data-badge-id="${id}"></script>`;

      return new Response(JSON.stringify({ ok: true, id, embed_code: embedCode }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  // PUT — update badge (logo, company name) — requires api_key or badge owner email
  if (request.method === 'PUT') {
    try {
      const body = await request.json();
      const { id, api_key, company, logo } = body;
      if (!id) {
        return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: CORS });
      }

      const data = await env.PULSE_KV.get(`vbadge:${id}`, 'json');
      if (!data) {
        return new Response(JSON.stringify({ error: 'Badge not found' }), { status: 404, headers: CORS });
      }

      // Simple auth: api_key must match stored key, or email match
      const storedKey = await env.PULSE_KV.get(`vbadge:key:${id}`);
      if (api_key && storedKey && api_key !== storedKey) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });
      }

      if (company !== undefined) data.company = company;
      if (logo !== undefined) {
        // Validate base64 image size (< 100KB)
        if (logo && logo.length > 136000) {
          return new Response(JSON.stringify({ error: 'Logo too large (max 100KB)' }), { status: 400, headers: CORS });
        }
        data.logo = logo;
      }

      await env.PULSE_KV.put(`vbadge:${id}`, JSON.stringify(data));

      return new Response(JSON.stringify({ ok: true, id: data.id }), {
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}
