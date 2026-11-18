/**
 * Compliance Evidence Collector — List Evidence
 * GET /api/evidence-collector/list?org=X&control=Y
 * 
 * Returns all evidence records for an org, optionally filtered by control.
 * Auth: X-Evidence-Token header (JWT with org claim)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Evidence-Token',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(atob(parts[0]));
    if (!payload.org || !payload.role || payload.role !== 'manager') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    const expected = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.EVIDENCE_JWT_SECRET || env.TRAINING_JWT_SECRET || 'fallback'),
      'HMAC', false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign(
      'HMAC', expected, new TextEncoder().encode(parts[0])
    ));
    const provided = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    if (sig.length !== provided.length) return null;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] !== provided[i]) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const token = context.request.headers.get('X-Evidence-Token');
  const manager = await verifyToken(token, context.env);
  if (!manager) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(context.request.url);
  const orgId = url.searchParams.get('org') || manager.org;
  const controlFilter = url.searchParams.get('control');

  try {
    const indexKey = `evidence:index:${orgId}`;
    const index = (await context.env.COMPLIANCE_KV.get(indexKey, 'json')) || [];

    let filtered = index;
    if (controlFilter) {
      filtered = index.filter(e => e.control_id === controlFilter);
    }

    // Sort newest first
    filtered.sort((a, b) => (b.submitted_at || '').localeCompare(a.submitted_at || ''));

    // Get summary stats
    const totalEvidence = index.length;
    const controlsCovered = new Set(index.map(e => e.control_id)).size;
    const pendingReview = index.filter(e => e.status === 'pending_review').length;
    const approved = index.filter(e => e.status === 'approved').length;

    return json({
      org_id: orgId,
      summary: {
        total_evidence: totalEvidence,
        controls_covered: controlsCovered,
        pending_review: pendingReview,
        approved: approved,
      },
      evidence: filtered,
    });

  } catch (e) {
    return json({ error: 'Failed to list evidence: ' + e.message }, 500);
  }
}
