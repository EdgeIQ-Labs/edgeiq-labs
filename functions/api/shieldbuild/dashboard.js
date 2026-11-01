// ShieldBuild Dashboard — GET /api/shieldbuild/dashboard
// Returns user's job sites, upcoming inspections, compliance status

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
    
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureInput = `${headerB64}.${payloadB64}`;
    
    // Convert base64url signature to ArrayBuffer
    const sigBase64 = sigB64.replace(/-/g, '+').replace(/_/g, '/');
    const sigBinary = atob(sigBase64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }
    
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes.buffer, encoder.encode(signatureInput));
    if (!valid) return null;
    
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    
    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload;
  } catch (e) {
    console.error('JWT verification error:', e);
    return null;
  }
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
  
  if (!kv) {
    return json({ error: 'KV namespace not bound' }, 500);
  }
  
  // Verify auth
  const authHeader = context.request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization required' }, 401);
  }
  
  const token = authHeader.substring(7);
  const user = await verifyJWT(token, jwtSecret);
  
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  
  try {
    // Get job sites
    const sitesList = await kv.list({ prefix: `jobsites:${user.sub}:` });
    const jobSites = [];
    for (const key of sitesList.keys) {
      const site = await kv.get(key.name, 'json');
      if (site) jobSites.push(site);
    }
    
    // Get incidents count
    const incidentsList = await kv.list({ prefix: `incidents:${user.sub}:` });
    const incidents = [];
    for (const key of incidentsList.keys) {
      const incident = await kv.get(key.name, 'json');
      if (incident) incidents.push(incident);
    }
    
    // Get calendar entries
    const calendarData = await kv.get(`calendar:${user.sub}`, 'json') || [];
    
    // Calculate compliance stats
    const now = new Date();
    const upcomingInspections = calendarData.filter(e => 
      e.type === 'inspection' && new Date(e.date) >= now
    ).length;
    
    const expiringSoon = calendarData.filter(e => {
      const daysUntil = Math.ceil((new Date(e.date) - now) / (1000 * 60 * 60 * 24));
      return daysUntil <= 30 && daysUntil >= 0;
    }).length;
    
    return json({
      user: {
        id: user.sub,
        email: user.email,
        name: user.name,
        tier: user.tier,
      },
      jobSites,
      incidents,
      calendar: calendarData,
      stats: {
        totalSites: jobSites.length,
        totalIncidents: incidents.length,
        upcomingInspections,
        expiringSoon,
        complianceScore: incidents.length === 0 ? 100 : Math.max(0, 100 - (incidents.length * 5)),
      }
    });
    
  } catch (err) {
    console.error('Dashboard error:', err);
    return json({ error: 'Failed to load dashboard', message: err.message }, 500);
  }
}
