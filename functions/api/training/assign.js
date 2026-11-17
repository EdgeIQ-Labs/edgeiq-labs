/**
 * Training Assignment API (PhishSim Webhook Target)
 * POST /api/training/assign
 * Body: { email, scenario, campaign_id }
 * Auth: X-Provision-Secret header (shared secret with PhishSim manager)
 *
 * Creates an assignment entry in KV that the training dashboard surfaces.
 * Does NOT require user JWT — called server-to-server from PhishSim webhook.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Provision-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Map GoPhish template names → training module scenario keys
const TEMPLATE_TO_SCENARIO = {
  'microsoft': 'microsoft',
  'google': 'google',
  'apple': 'apple',
  'linkedin': 'linkedin',
  'paypal': 'paypal',
  'amazon': 'amazon',
  'banking': 'banking',
  'okta': 'okta',
  'dropbox': 'dropbox',
  'helpdesk': 'helpdesk',
  'vpn': 'vpn',
  'docusign': 'docusign',
  'onedrive': 'onedrive',
};

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Verify shared secret
  const secret = context.request.headers.get('X-Provision-Secret');
  const expected = context.env.PHISHSIM_SECRET;
  if (!secret || !expected || secret !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await context.request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  if (!body.email || !body.scenario) {
    return json({ error: 'email and scenario required' }, 400);
  }

  const email = body.email.toLowerCase();
  const scenario = TEMPLATE_TO_SCENARIO[body.scenario.toLowerCase()] || body.scenario.toLowerCase();

  // Write assignment to KV with 30-day TTL
  const assignKey = `training:assign:${email}:${scenario}`;
  const assignment = {
    email,
    scenario,
    campaign_id: body.campaign_id || null,
    assigned_at: new Date().toISOString(),
    due_by: new Date(Date.now() + 7 * 86400000).toISOString(), // 7 days to complete
  };
  await context.env.PULSE_KV.put(assignKey, JSON.stringify(assignment), { expirationTtl: 2592000 });

  // Update user's assignment index
  const indexKey = `training:assignments:${email}`;
  const existing = (await context.env.PULSE_KV.get(indexKey, 'json')) || [];
  // Dedupe by scenario
  const filtered = existing.filter(a => a.scenario !== scenario);
  filtered.push(assignment);
  await context.env.PULSE_KV.put(indexKey, JSON.stringify(filtered));

  return json({ ok: true, assigned: assignment });
}
