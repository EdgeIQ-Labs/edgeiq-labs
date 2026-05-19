/**
 * GET /api/account/me
 *
 * Returns the authenticated user's subscriptions across all EdgeIQ products.
 * Requires a valid edgeiq_session cookie (set by /api/account/verify).
 *
 * Also creates a Stripe billing portal session if the email has a Stripe
 * customer record, so the client can link directly to billing management.
 *
 * KV binding: PULSE_KV
 * Env vars:   STRIPE_SECRET_KEY, SITE_URL
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function parseSessionCookie(cookieHeader) {
  const match = (cookieHeader || '').match(/edgeiq_session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

async function getSession(env, sessionId) {
  if (!sessionId) return null;
  try {
    const raw = await env.PULSE_KV.get(`acct:session:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function fetchKvJson(env, key) {
  try {
    const raw = await env.PULSE_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function getStripePortalUrl(env, email, returnUrl) {
  if (!env.STRIPE_SECRET_KEY) return null;
  try {
    // Find the Stripe customer by email
    const searchResp = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!searchResp.ok) return null;
    const searchData = await searchResp.json();
    if (!searchData.data?.length) return null;

    const customerId = searchData.data[0].id;

    // Create a billing portal session
    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `customer=${encodeURIComponent(customerId)}&return_url=${encodeURIComponent(returnUrl)}`,
      signal: AbortSignal.timeout(6000),
    });
    if (!portalResp.ok) return null;
    const portalData = await portalResp.json();
    return portalData.url || null;
  } catch {
    return null;
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  if (!env.PULSE_KV) return json({ error: 'Service unavailable.' }, 503);

  const sessionId = parseSessionCookie(request.headers.get('Cookie'));
  const session = await getSession(env, sessionId);
  if (!session) return json({ ok: false, error: 'Not authenticated.' }, 401);

  const { email } = session;
  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';

  // Fetch all subscriptions for this email in parallel
  const [pulseList, shieldList, vendorRaw, mspRaw, complianceList, brandguardList] = await Promise.all([
    env.PULSE_KV.list({ prefix: `sub:${email}:` }),
    env.PULSE_KV.list({ prefix: `shield:${email}:` }),
    fetchKvJson(env, `vendor:${email}`),
    fetchKvJson(env, `msp:${email}`),
    env.PULSE_KV.list({ prefix: `compliance:${email}:` }),
    env.PULSE_KV.list({ prefix: `brandguard:${email}:` }),
  ]);

  // Fetch full subscriber records for Pulse
  const pulseRecords = await Promise.all(
    pulseList.keys.map(async k => {
      const rec = await fetchKvJson(env, k.name);
      if (!rec) return null;
      return {
        domain: rec.domain,
        plan: rec.plan || 'free',
        active: rec.active !== false,
        created_at: rec.created_at,
        last_scan: rec.last_scan,
        findings_summary: rec.last_findings
          ? Object.fromEntries(
              Object.entries(rec.last_findings).map(([k, v]) => [k, v.status])
            )
          : null,
        has_issues: rec.last_findings
          ? Object.values(rec.last_findings).some(f => f.status === 'bad' || f.status === 'warning')
          : false,
      };
    })
  ).then(r => r.filter(Boolean));

  // Fetch full subscriber records for Inbox Shield
  const shieldRecords = await Promise.all(
    shieldList.keys.map(async k => {
      const rec = await fetchKvJson(env, k.name);
      if (!rec) return null;
      return {
        domain: rec.domain,
        plan: rec.plan || 'free',
        active: rec.active !== false,
        created_at: rec.created_at,
        last_scan: rec.last_scan,
        grade: rec.last_findings?.grade || null,
        checks: rec.last_findings?.checks
          ? Object.fromEntries(
              Object.entries(rec.last_findings.checks).map(([k, v]) => [k, v.grade])
            )
          : null,
      };
    })
  ).then(r => r.filter(Boolean));

  // Vendor Watch (single record per email)
  const vendorRecord = vendorRaw ? {
    vendors: vendorRaw.vendors || [],
    plan: vendorRaw.plan || 'free',
    active: vendorRaw.active !== false,
    created_at: vendorRaw.created_at,
    last_check: vendorRaw.last_check,
    last_statuses: vendorRaw.last_statuses || {},
  } : null;

  // MSP Essentials (single record per email)
  const mspRecord = mspRaw ? {
    plan: 'msp',
    seats: mspRaw.seats || 10,
    clients: mspRaw.clients || [],
    active: mspRaw.active !== false,
    created_at: mspRaw.created_at,
  } : null;

  // Compliance Pro (one record per domain)
  const complianceRecords = await Promise.all(
    complianceList.keys.map(async k => {
      const rec = await fetchKvJson(env, k.name);
      if (!rec) return null;
      return {
        domain:       rec.domain,
        plan:         rec.plan || 'free',
        active:       rec.active !== false,
        created_at:   rec.created_at,
        last_scan_at: rec.last_scan_at,
        last_score:   rec.last_score ?? null,
        last_grade:   rec.last_grade ?? null,
        scan_count:   rec.scan_count || 0,
      };
    })
  ).then(r => r.filter(Boolean));

  // BrandGuard (one record per domain)
  const brandguardRecords = await Promise.all(
    brandguardList.keys.map(async k => {
      const rec = await fetchKvJson(env, k.name);
      if (!rec) return null;
      return {
        domain:           rec.domain,
        plan:             rec.plan || 'standard',
        active:           rec.active !== false,
        created_at:       rec.created_at,
        last_scan_at:     rec.last_scan_at,
        known_active:     rec.known_active || [],
        known_suspicious: rec.known_suspicious || [],
        scan_count:       rec.scan_count || 0,
      };
    })
  ).then(r => r.filter(Boolean));

  // Try to create a Stripe billing portal URL (best-effort)
  const portalUrl = await getStripePortalUrl(env, email, `${siteUrl}/account/`);

  return json({
    ok: true,
    email,
    subscriptions: {
      pulse: pulseRecords,
      inbox_shield: shieldRecords,
      vendor_watch: vendorRecord,
      msp: mspRecord,
      compliance: complianceRecords,
      brandguard: brandguardRecords,
    },
    billing_portal_url: portalUrl,
    site_url: siteUrl,
  });
}
