/**
 * Compliance Evidence Collector — Submit Evidence
 * POST /api/evidence-collector/submit
 * 
 * Accepts multipart/form-data with:
 *   - file: screenshot/PDF/document (max 25MB)
 *   - control_id: HIPAA/OSHA/SOC2 control identifier
 *   - description: what this evidence demonstrates
 *   - org_id: organization identifier (from subscription)
 * 
 * Auth: X-Evidence-Token header (JWT with org claim)
 * Stores in COMPLIANCE_KV as evidence:{org_id}:{evidence_id}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
  if (context.request.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  const token = context.request.headers.get('X-Evidence-Token');
  const manager = await verifyToken(token, context.env);
  if (!manager) {
    return json({ error: 'unauthorized — manager access required' }, 401);
  }

  const orgId = manager.org;

  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    const controlId = formData.get('control_id');
    const description = formData.get('description');

    if (!file || !controlId) {
      return json({ error: 'file and control_id required' }, 400);
    }

    // Validate file size (25MB max for KV base64 storage)
    if (file.size > 25 * 1024 * 1024) {
      return json({ error: 'File too large. Max 25MB.' }, 413);
    }

    // Read file as base64
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    
    const evidenceId = crypto.randomUUID().slice(0, 12);
    const submittedAt = new Date().toISOString();

    const evidenceRecord = {
      id: evidenceId,
      org_id: orgId,
      control_id: controlId,
      description: description || '',
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      data_base64: base64,
      submitted_at: submittedAt,
      submitted_by: manager.email || 'unknown',
      status: 'pending_review',
    };

    // Store in KV
    await context.env.COMPLIANCE_KV.put(
      `evidence:${orgId}:${evidenceId}`,
      JSON.stringify(evidenceRecord),
      { expirationTtl: 86400 * 365 } // 1 year retention
    );

    // Update org index
    const indexKey = `evidence:index:${orgId}`;
    const existingIndex = (await context.env.COMPLIANCE_KV.get(indexKey, 'json')) || [];
    existingIndex.push({
      id: evidenceId,
      control_id: controlId,
      filename: file.name,
      submitted_at: submittedAt,
      status: 'pending_review',
    });
    await context.env.COMPLIANCE_KV.put(indexKey, JSON.stringify(existingIndex), {
      expirationTtl: 86400 * 365,
    });

    return json({
      ok: true,
      evidence_id: evidenceId,
      control_id: controlId,
      filename: file.name,
      size_bytes: file.size,
      submitted_at: submittedAt,
    }, 201);

  } catch (e) {
    return json({ error: 'Upload failed: ' + e.message }, 500);
  }
}
