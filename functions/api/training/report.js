/**
 * Training Compliance Report API
 * GET /api/training/report?org=X     → { users: [...], summary: {...} }
 * Auth: X-Training-Token (manager-level JWT with org claim)
 *
 * Returns completion data for all users in an organization.
 * Used by manager dashboard and PDF export.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Training-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyManagerToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(atob(parts[0]));
    if (!payload.org || !payload.role || payload.role !== 'manager') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
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
  const manager = await verifyManagerToken(token, context.env);
  if (!manager) return json({ error: 'unauthorized — manager access required' }, 401);

  const url = new URL(context.request.url);
  const org = url.searchParams.get('org') || manager.org;

  // Read org roster
  const rosterKey = `training:roster:${org}`;
  const roster = (await context.env.PULSE_KV.get(rosterKey, 'json')) || [];

  const users = [];
  let totalCompleted = 0;
  let totalAssigned = 0;

  for (const userEmail of roster) {
    const progressKey = `training:progress:${userEmail.toLowerCase()}`;
    const assignmentsKey = `training:assignments:${userEmail.toLowerCase()}`;
    const progress = (await context.env.PULSE_KV.get(progressKey, 'json')) || {};
    const assignments = (await context.env.PULSE_KV.get(assignmentsKey, 'json')) || [];

    const completedModules = Object.keys(progress).length;
    const pendingAssignments = assignments.filter(a => !progress[a.scenario]).length;
    totalCompleted += completedModules;
    totalAssigned += assignments.length;

    users.push({
      email: userEmail,
      completed_modules: completedModules,
      pending_assignments: pendingAssignments,
      last_completed: Object.values(progress).sort((a, b) => 
        (b.completed_at || '').localeCompare(a.completed_at || '')
      )[0]?.completed_at || null,
      modules: progress,
    });
  }

  return json({
    org,
    generated_at: new Date().toISOString(),
    summary: {
      total_users: roster.length,
      total_modules_completed: totalCompleted,
      total_assignments: totalAssigned,
      completion_rate: totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0,
    },
    users,
  });
}
