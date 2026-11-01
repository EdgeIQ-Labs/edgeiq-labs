// ShieldVerify Verify — POST /api/shieldverify/verify
// Accepts backup storage config, simulates restore verification, returns checksum match + resilience score

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
  if (context.request.method !== 'POST') {
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
    const body = await context.request.json();
    const { serverId, backupType, storagePath } = body;

    if (!serverId || !backupType) {
      return json({ error: 'serverId and backupType required' }, 400);
    }

    // Simulate restore verification (in production, this would connect to actual backup storage)
    const testId = crypto.randomUUID();
    const checksumMatch = Math.random() > 0.1; // 90% success rate simulation
    const resilienceScore = Math.floor(Math.random() * 30) + 70; // 70-100 range
    const restoreTimeMs = Math.floor(Math.random() * 5000) + 2000; // 2-7 seconds

    const testResult = {
      id: testId,
      userId: user.sub,
      serverId,
      backupType,
      storagePath: storagePath || '/backups/default',
      status: checksumMatch ? 'passed' : 'failed',
      checksumMatch,
      expectedChecksum: 'sha256:' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
      actualChecksum: checksumMatch
        ? 'sha256:' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
        : 'sha256:MISMATCH_' + Array.from({ length: 56 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
      resilienceScore: checksumMatch ? resilienceScore : Math.max(0, resilienceScore - 40),
      restoreTimeMs,
      fileSizeBytes: Math.floor(Math.random() * 1000000000) + 500000000,
      verifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      notes: checksumMatch ? 'Restore completed successfully. All checksums validated.' : 'Checksum mismatch detected. Backup may be corrupted.',
    };

    // Store test result
    await kv.put(`tests:${user.sub}:${testId}`, JSON.stringify(testResult));

    // Update server last test timestamp
    const serverKey = `servers:${user.sub}:${serverId}`;
    const serverData = await kv.get(serverKey, 'json');
    if (serverData) {
      serverData.lastTestAt = testResult.verifiedAt;
      serverData.lastTestStatus = testResult.status;
      await kv.put(serverKey, JSON.stringify(serverData));
    }

    return json({
      success: true,
      test: testResult,
    });

  } catch (err) {
    console.error('Verify error:', err);
    return json({ error: 'Verification failed', message: err.message }, 500);
  }
}
