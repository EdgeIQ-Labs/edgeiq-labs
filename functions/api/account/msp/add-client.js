/**
 * POST /api/account/msp/add-client
 * Body: { domain }
 *
 * Adds a client domain to the MSP account's seat list.
 * Requires a valid edgeiq_session cookie (set by /api/account/verify).
 *
 * On success:
 *   - Validates seat count (max 10)
 *   - Creates sub:{email}:{domain} in KV for Pulse cron pickup
 *   - Creates shield:{email}:{domain} in KV for Inbox Shield cron pickup
 *   - Updates msp:{email}.clients[]
 *
 * DELETE /api/account/msp/add-client
 * Body: { domain }
 *
 * Removes a client domain from the MSP account and deletes its KV records.
 *
 * KV binding: PULSE_KV
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const MSP_MAX_SEATS = 10;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function parseSessionCookie(cookieHeader) {
  const match = (cookieHeader || '').match(/edgeiq_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

async function getSession(env, sessionId) {
  if (!sessionId || !env.PULSE_KV) return null;
  try {
    const raw = await env.PULSE_KV.get(`acct:session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function normalizeDomain(input) {
  try {
    const s = input.trim().toLowerCase().replace(/^https?:\/\//, '');
    const parts = s.split('/')[0].split(':')[0];
    // Basic domain validation
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(parts)) return null;
    return parts;
  } catch { return null; }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  if (!env.PULSE_KV) return json({ error: 'Service unavailable.' }, 503);

  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  const session = await getSession(env, sessionId);
  if (!session) return json({ error: 'Not authenticated.' }, 401);

  const { email } = session;

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const domain = normalizeDomain(body.domain || '');
  if (!domain) return json({ error: 'Invalid domain.' }, 400);

  // Load MSP record
  const mspRaw = await env.PULSE_KV.get(`msp:${email}`).catch(() => null);
  if (!mspRaw) return json({ error: 'No MSP subscription found.' }, 403);

  let msp;
  try { msp = JSON.parse(mspRaw); } catch {
    return json({ error: 'Invalid MSP record.' }, 500);
  }

  if (!msp.active) return json({ error: 'MSP subscription is not active.' }, 403);

  const clients = msp.clients || [];

  // Check for duplicate
  if (clients.includes(domain)) {
    return json({ error: 'Domain is already in your client list.' }, 409);
  }

  // Check seat limit
  if (clients.length >= MSP_MAX_SEATS) {
    return json({ error: `Seat limit reached (${MSP_MAX_SEATS} domains max).` }, 422);
  }

  const now = new Date().toISOString();

  // Create Pulse subscriber record
  await env.PULSE_KV.put(
    `sub:${email}:${domain}`,
    JSON.stringify({
      email,
      domain,
      plan: 'pro',        // MSP seats get Pro-level scans
      active: true,
      stripe_session_id: msp.stripe_session_id,
      source: 'msp',
      created_at: now,
    })
  );

  // Create Inbox Shield subscriber record
  await env.PULSE_KV.put(
    `shield:${email}:${domain}`,
    JSON.stringify({
      email,
      domain,
      plan: 'pro',
      active: true,
      stripe_session_id: msp.stripe_session_id,
      source: 'msp',
      created_at: now,
    })
  );

  // Update MSP record
  msp.clients = [...clients, domain];
  await env.PULSE_KV.put(`msp:${email}`, JSON.stringify(msp));

  return json({
    ok: true,
    domain,
    seats_used: msp.clients.length,
    seats_total: MSP_MAX_SEATS,
  });
}

export async function onRequestDelete({ request, env }) {
  if (!env.PULSE_KV) return json({ error: 'Service unavailable.' }, 503);

  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  const session = await getSession(env, sessionId);
  if (!session) return json({ error: 'Not authenticated.' }, 401);

  const { email } = session;

  let body;
  try { body = await request.json(); } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const domain = normalizeDomain(body.domain || '');
  if (!domain) return json({ error: 'Invalid domain.' }, 400);

  // Load MSP record
  const mspRaw = await env.PULSE_KV.get(`msp:${email}`).catch(() => null);
  if (!mspRaw) return json({ error: 'No MSP subscription found.' }, 403);

  let msp;
  try { msp = JSON.parse(mspRaw); } catch {
    return json({ error: 'Invalid MSP record.' }, 500);
  }

  const clients = msp.clients || [];
  if (!clients.includes(domain)) {
    return json({ error: 'Domain not found in your client list.' }, 404);
  }

  // Remove KV records
  await Promise.all([
    env.PULSE_KV.delete(`sub:${email}:${domain}`).catch(() => {}),
    env.PULSE_KV.delete(`shield:${email}:${domain}`).catch(() => {}),
  ]);

  // Update MSP record
  msp.clients = clients.filter(c => c !== domain);
  await env.PULSE_KV.put(`msp:${email}`, JSON.stringify(msp));

  return json({
    ok: true,
    domain,
    seats_used: msp.clients.length,
    seats_total: MSP_MAX_SEATS,
  });
}
