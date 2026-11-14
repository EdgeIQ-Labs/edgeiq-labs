/**
 * Security Badge API
 * GET /api/badge?id=<scan_id> — returns cached score for badge rendering
 * POST /api/badge — stores a new scan result (called by free tools after analysis)
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Missing id parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const data = await env.PULSE_KV.get(`badge:${id}`, 'json');
      if (!data) {
        return new Response(JSON.stringify({ error: 'Badge not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Return only public-safe fields
      return new Response(JSON.stringify({
        id: data.id,
        grade: data.grade,
        score: data.score,
        tool: data.tool,
        domain: data.domain || null,
        verified_at: data.verified_at,
        report_url: data.report_url || `https://edgeiqlabs.com/${data.tool}/`
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { tool, score, grade, domain, report_url } = body;

      if (!tool || score === undefined || !grade) {
        return new Response(JSON.stringify({ error: 'tool, score, and grade are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Generate a unique badge ID
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

      const badgeData = {
        id,
        tool,
        score: Math.min(100, Math.max(0, Number(score))),
        grade: grade.toUpperCase(),
        domain: domain || null,
        report_url: report_url || `https://edgeiqlabs.com/${tool}/`,
        verified_at: new Date().toISOString()
      };

      // Store in KV with 90-day TTL
      await env.PULSE_KV.put(`badge:${id}`, JSON.stringify(badgeData), { expirationTtl: 7776000 });

      return new Response(JSON.stringify({
        ok: true,
        id,
        embed_code: `<script src="https://edgeiqlabs.com/badge.js" data-badge-id="${id}"></script>`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  return new Response('Method not allowed', { status: 405 });
}
