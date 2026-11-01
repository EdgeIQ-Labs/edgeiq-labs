// ShieldVerify Dashboard — GET /api/shieldverify/dashboard
// Returns server list, test results, resilience scores for authenticated user

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
    // Get servers
    const serversList = await kv.list({ prefix: `servers:${user.sub}:` });
    const servers = [];
    for (const key of serversList.keys) {
      const server = await kv.get(key.name, 'json');
      if (server) servers.push(server);
    }

    // Get test results
    const testsList = await kv.list({ prefix: `tests:${user.sub}:` });
    const tests = [];
    for (const key of testsList.keys) {
      const test = await kv.get(key.name, 'json');
      if (test) tests.push(test);
    }

    // Sort tests by date descending
    tests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Calculate stats
    const totalTests = tests.length;
    const passedTests = tests.filter(t => t.status === 'passed').length;
    const failedTests = tests.filter(t => t.status === 'failed').length;
    const avgResilience = tests.length > 0
      ? Math.round(tests.reduce((sum, t) => sum + (t.resilienceScore || 0), 0) / tests.length)
      : 0;

    return json({
      user: {
        id: user.sub,
        email: user.email,
        name: user.name,
        tier: user.tier,
      },
      servers,
      tests: tests.slice(0, 50),
      stats: {
        totalServers: servers.length,
        totalTests,
        passedTests,
        failedTests,
        passRate: totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0,
        avgResilienceScore: avgResilience,
      }
    });

  } catch (err) {
    console.error('Dashboard error:', err);
    return json({ error: 'Dashboard fetch failed', message: err.message }, 500);
  }
}
