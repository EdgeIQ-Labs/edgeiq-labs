// ShieldBuild Calendar — GET /api/shieldbuild/calendar
// Returns compliance deadlines, permit renewals, training expirations

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
    const sigBase64 = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const sigBinary = atob(sigBase64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes.buffer, encoder.encode(signatureInput));
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
  
  const kv = context.env.SHIELDBUILD_KV;
  const jwtSecret = context.env.SHIELDBUILD_JWT_SECRET || 'shieldbuild-dev-secret-change-in-prod';
  if (!kv) return json({ error: 'KV namespace not bound' }, 500);
  
  const authHeader = context.request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization required' }, 401);
  }
  
  const user = await verifyJWT(authHeader.substring(7), jwtSecret);
  if (!user) return json({ error: 'Invalid or expired token' }, 401);
  
  try {
    const calendarData = await kv.get(`calendar:${user.sub}`, 'json') || [];
    
    // Calculate daysUntilExpiry for each entry
    const now = new Date();
    const enriched = calendarData.map(entry => {
      const entryDate = new Date(entry.date);
      const daysUntilExpiry = Math.ceil((entryDate - now) / (1000 * 60 * 60 * 24));
      return { ...entry, daysUntilExpiry };
    });
    
    // Sort by date ascending
    enriched.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    return json({ calendar: enriched, count: enriched.length });
    
  } catch (err) {
    console.error('Calendar error:', err);
    return json({ error: 'Failed to load calendar', message: err.message }, 500);
  }
}
