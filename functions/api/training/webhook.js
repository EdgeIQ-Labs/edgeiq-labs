/**
 * Training Webhook Handler
 * POST /api/training/webhook
 * Auth: X-Training-Token (user JWT)
 * Body: { module_id, score, total_questions }
 *
 * Records module completion in KV.
 * Called by the training frontend when user finishes a quiz.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Training-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(atob(parts[0]));
    if (!payload.email || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    const expected = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.TRAINING_JWT_SECRET || 'fallback'),
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
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const token = context.request.headers.get('X-Training-Token');
  const user = await verifyToken(token, context.env);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  if (!body.module_id || typeof body.score !== 'number') {
    return json({ error: 'module_id and score required' }, 400);
  }

  const email = user.email.toLowerCase();
  const kvKey = `training:progress:${email}`;
  const existing = (await context.env.PULSE_KV.get(kvKey, 'json')) || {};

  existing[body.module_id] = {
    completed_at: new Date().toISOString(),
    score: body.score,
    total_questions: body.total_questions || 3,
    attempts: (existing[body.module_id]?.attempts || 0) + 1,
  };

  await context.env.PULSE_KV.put(kvKey, JSON.stringify(existing));

  // Check if this completes an assignment
  const assignKey = `training:assignments:${email}`;
  const assignments = (await context.env.PULSE_KV.get(assignKey, 'json')) || [];
  const completedAssignment = assignments.find(a => a.scenario === body.module_id && !a.completed_at);
  if (completedAssignment) {
    completedAssignment.completed_at = new Date().toISOString();
    completedAssignment.score = body.score;
    await context.env.PULSE_KV.put(assignKey, JSON.stringify(assignments));
  }

  return json({ ok: true, module: existing[body.module_id], assignment_completed: !!completedAssignment });
}
