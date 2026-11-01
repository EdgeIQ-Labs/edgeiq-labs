// ShieldVerify Reports — GET /api/shieldverify/reports
// Lists generated compliance reports for authenticated user

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureInput = `${headerB64}.${payloadB64}`;
    const sigBinary = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBuffer = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) sigBuffer[i] = sigBinary.charCodeAt(i);
    const valid = await crypto.subtle.verify('HMAC', key, sigBuffer, encoder.encode(signatureInput));
    if (!valid) return null;
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const kv = context.env.SHIELDVERIFY_KV;
  const jwtSecret = context.env.SHIELDVERIFY_JWT_SECRET || 'shieldverify-dev-secret-change-in-prod';
  if (!kv) return json({ error: 'KV namespace not bound' }, 500);

  const authHeader = context.request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return json({ error: 'Authorization required' }, 401);
  const user = await verifyJWT(authHeader.slice(7), jwtSecret);
  if (!user) return json({ error: 'Invalid or expired token' }, 401);

  try {
    // Get reports
    const reportsList = await kv.list({ prefix: `reports:${user.sub}:` });
    const reports = [];
    for (const key of reportsList.keys) {
      const report = await kv.get(key.name, 'json');
      if (report) reports.push(report);
    }

    // Sort by date descending
    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return json({
      reports,
      total: reports.length,
    });

  } catch (err) {
    console.error('Reports error:', err);
    return json({ error: 'Failed to load reports', message: err.message }, 500);
  }
}
