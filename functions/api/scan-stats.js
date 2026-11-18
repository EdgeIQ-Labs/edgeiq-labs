/**
 * EdgeIQ — Aggregate scan statistics
 * GET  /api/scan-stats  → returns {ssl, spf, repo, dmarc, total}
 * POST /api/scan-stats  → increments counter for given tool
 *
 * Uses PULSE_KV to persist counts across all edge nodes.
 */

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.PULSE_KV) {
    return Response.json({ ssl: 0, spf: 0, repo: 0, dmarc: 0, total: 0 });
  }
  try {
    const raw = await env.PULSE_KV.get('scan:stats', 'json') || {};
    const ssl = raw.ssl || 0;
    const spf = raw.spf || 0;
    const repo = raw.repo || 0;
    const dmarc = raw.dmarc || 0;
    const total = ssl + spf + repo + dmarc;
    return Response.json({ ssl, spf, repo, dmarc, total });
  } catch (_) {
    return Response.json({ ssl: 0, spf: 0, repo: 0, dmarc: 0, total: 0 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.PULSE_KV) return Response.json({ ok: false, error: 'no kv' }, { status: 500 });

  let body;
  try { body = await request.json(); } catch (_) { return Response.json({ ok: false }); }

  const tool = (body.tool || '').toLowerCase().replace(/[^a-z-]/g, '');
  const validTools = ['ssl', 'spf', 'repo', 'dmarc'];
  if (!validTools.includes(tool)) return Response.json({ ok: false, error: 'invalid tool' });

  try {
    const stats = await env.PULSE_KV.get('scan:stats', 'json') || { ssl: 0, spf: 0, repo: 0, dmarc: 0 };
    stats[tool] = (stats[tool] || 0) + 1;
    await env.PULSE_KV.put('scan:stats', JSON.stringify(stats));
    return Response.json({ ok: true, count: stats[tool] });
  } catch (_) {
    return Response.json({ ok: false });
  }
}
