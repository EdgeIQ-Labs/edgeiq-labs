// ShieldBuild Incident — POST /api/shieldbuild/incident
// Create new incident report

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
  if (context.request.method !== 'POST') {
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
    const body = await context.request.json();
    const { siteId, type, date, location, description, severity, injuredPersons, witnesses, correctiveActions } = body;
    
    if (!siteId || !type || !date || !description) {
      return json({ error: 'Required fields: siteId, type, date, description' }, 400);
    }
    
    const incidentId = crypto.randomUUID();
    const incident = {
      id: incidentId,
      userId: user.sub,
      siteId,
      type, // injury, near_miss, property_damage, environmental
      date,
      location: location || '',
      description,
      severity: severity || 'medium', // low, medium, high, critical
      injuredPersons: injuredPersons || [],
      witnesses: witnesses || [],
      correctiveActions: correctiveActions || '',
      status: 'open', // open, investigating, closed
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await kv.put(`incidents:${user.sub}:${incidentId}`, JSON.stringify(incident));
    
    return json({ success: true, incident }, 201);
    
  } catch (err) {
    console.error('Incident creation error:', err);
    return json({ error: 'Failed to create incident', message: err.message }, 500);
  }
}
