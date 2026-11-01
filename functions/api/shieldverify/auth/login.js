// ShieldVerify Auth — POST /api/shieldverify/auth/login
// JWT auth using Web Crypto API HMAC-SHA256, KV-backed

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function createJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signatureInput = `${headerB64}.${payloadB64}`;

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureInput));
  const sigBytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < sigBytes.length; i++) {
    binary += String.fromCharCode(sigBytes[i]);
  }
  const sigBase64Url = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${headerB64}.${payloadB64}.${sigBase64Url}`;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const kv = context.env.SHIELDVERIFY_KV;
  const jwtSecret = context.env.SHIELDVERIFY_JWT_SECRET || 'shieldverify-dev-secret-change-in-prod';

  if (!kv) {
    return json({ error: 'KV namespace not bound' }, 500);
  }

  try {
    const body = await context.request.json();
    const { email, password } = body;

    if (!email || !password) {
      return json({ error: 'Email and password required' }, 400);
    }

    const userKey = `users:${email.toLowerCase()}`;
    const userData = await kv.get(userKey, 'json');

    if (!userData) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    if (userData.password !== password) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    const payload = {
      sub: userData.id,
      email: userData.email,
      tier: userData.tier,
      name: userData.name,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60),
    };

    const token = await createJWT(payload, jwtSecret);

    return json({
      token,
      user: {
        id: userData.id,
        email: userData.email,
        name: userData.name,
        tier: userData.tier,
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    return json({ error: 'Authentication failed', message: err.message }, 500);
  }
}
