// ShieldBuild OSHA 300 Generator — POST /api/shieldbuild/osha300/generate
// Generates OSHA 300 log HTML from incident data (printable)

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
    const body = await context.request.json().catch(() => ({}));
    const year = body.year || new Date().getFullYear();
    const siteId = body.siteId;
    
    // Get incidents for the year
    const list = await kv.list({ prefix: `incidents:${user.sub}:` });
    const incidents = [];
    for (const key of list.keys) {
      const incident = await kv.get(key.name, 'json');
      if (incident && incident.type === 'injury') {
        const incDate = new Date(incident.date);
        if (incDate.getFullYear() === year) {
          if (!siteId || incident.siteId === siteId) {
            incidents.push(incident);
          }
        }
      }
    }
    
    // Get company info
    const userData = await kv.get(`users:${user.email}`, 'json');
    const companyName = userData?.companyName || 'Construction Company';
    
    // Generate OSHA 300 HTML
    const html = generateOSHA300HTML(companyName, year, incidents);
    
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...CORS_HEADERS,
      },
    });
    
  } catch (err) {
    console.error('OSHA 300 generation error:', err);
    return json({ error: 'Failed to generate OSHA 300 log', message: err.message }, 500);
  }
}

function generateOSHA300HTML(companyName, year, incidents) {
  const rows = incidents.map((inc, idx) => {
    const date = new Date(inc.date);
    const dateStr = `${(date.getMonth()+1).toString().padStart(2,'0')}/${date.getDate().toString().padStart(2,'0')}/${date.getFullYear()}`;
    const daysAway = inc.daysAwayFromWork || 0;
    const daysRestricted = inc.daysOfJobRestriction || 0;
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>${dateStr}</td>
        <td>${escapeHtml(inc.location || 'N/A')}</td>
        <td>${escapeHtml(inc.description)}</td>
        <td>${inc.injuredPersons?.[0]?.name || 'N/A'}</td>
        <td>${daysAway}</td>
        <td>${daysRestricted}</td>
        <td>${getInjuryType(inc)}</td>
      </tr>`;
  }).join('');
  
  const totalCases = incidents.length;
  const totalDaysAway = incidents.reduce((sum, i) => sum + (i.daysAwayFromWork || 0), 0);
  const totalRestricted = incidents.reduce((sum, i) => sum + (i.daysOfJobRestriction || 0), 0);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>OSHA Form 300 — ${year}</title>
  <style>
    @media print {
      body { margin: 0; }
      .no-print { display: none; }
    }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 20px; color: #000; background: #fff; }
    h1 { font-size: 16px; text-align: center; margin-bottom: 4px; }
    h2 { font-size: 13px; text-align: center; margin-bottom: 16px; color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #000; padding: 4px 6px; text-align: left; vertical-align: top; }
    th { background: #f0f0f0; font-weight: bold; font-size: 10px; text-transform: uppercase; }
    .summary { margin-top: 20px; border-top: 2px solid #000; padding-top: 12px; }
    .summary td { border: none; padding: 2px 8px; }
    .btn { display: inline-block; padding: 10px 24px; background: #0C0C14; color: #fff; border: none; cursor: pointer; font-size: 14px; border-radius: 6px; margin: 16px 0; }
    .btn:hover { background: #1a1a2e; }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
    <p style="color:#666;font-size:12px;margin-bottom:16px;">Use your browser's print function to save this OSHA 300 log as a PDF.</p>
  </div>
  
  <h1>OSHA's Form 300</h1>
  <h2>Log of Work-Related Injuries and Illnesses — ${year}</h2>
  <p><strong>Company:</strong> ${escapeHtml(companyName)} &nbsp;|&nbsp; <strong>Year:</strong> ${year}</p>
  
  <table>
    <thead>
      <tr>
        <th style="width:4%">#</th>
        <th style="width:10%">Date</th>
        <th style="width:12%">Location</th>
        <th style="width:30%">Description</th>
        <th style="width:14%">Employee</th>
        <th style="width:8%">Days Away</th>
        <th style="width:8%">Restricted</th>
        <th style="width:14%">Injury Type</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="8" style="text-align:center;padding:20px;color:#666;">No recordable injuries for this period</td></tr>'}
    </tbody>
  </table>
  
  <div class="summary">
    <table style="width:auto;border:none;">
      <tr><td><strong>Total Recordable Cases:</strong></td><td>${totalCases}</td></tr>
      <tr><td><strong>Total Days Away From Work:</strong></td><td>${totalDaysAway}</td></tr>
      <tr><td><strong>Total Days of Job Restriction:</strong></td><td>${totalRestricted}</td></tr>
    </table>
  </div>
  
  <p style="margin-top:24px;font-size:9px;color:#666;">
    Generated by ShieldBuild on ${new Date().toLocaleDateString()}. This form should be posted at each establishment where records are maintained.
    Per OSHA regulations, this log must be maintained for 5 years following the end of the calendar year covered.
  </p>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getInjuryType(incident) {
  if (incident.severity === 'critical') return 'Fatality/Major';
  if (incident.daysAwayFromWork > 0) return 'Days Away';
  if (incident.daysOfJobRestriction > 0) return 'Restricted';
  return 'Other Recordable';
}
