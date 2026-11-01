// ShieldInvoice Export — POST /api/shieldinvoice/export
// Export invoices as CSV (auth-gated)

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

function escapeCSV(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  
  const kv = context.env.SHIELDINVOICE_KV;
  const jwtSecret = context.env.SHIELDINVOICE_JWT_SECRET || 'shieldinvoice-dev-secret-change-in-prod';
  if (!kv) return json({ error: 'KV namespace not bound' }, 500);
  
  const authHeader = context.request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return json({ error: 'Authorization required' }, 401);
  const user = await verifyJWT(authHeader.slice(7), jwtSecret);
  if (!user) return json({ error: 'Invalid or expired token' }, 401);
  
  try {
    const body = await context.request.json().catch(() => ({}));
    const invoiceIds = body.invoiceIds || null; // null = all
    
    let invoices = [];
    
    if (invoiceIds && Array.isArray(invoiceIds)) {
      for (const id of invoiceIds) {
        const inv = await kv.get(`invoices:${user.sub}:${id}`, 'json');
        if (inv) invoices.push(inv);
      }
    } else {
      const index = await kv.get(`index:${user.sub}`, 'json') || [];
      for (const item of index) {
        const inv = await kv.get(`invoices:${user.sub}:${item.id}`, 'json');
        if (inv) invoices.push(inv);
      }
    }
    
    // Build CSV
    const headers = ['Invoice ID', 'Vendor Name', 'Invoice Number', 'Date', 'PO Number', 'Subtotal', 'Tax', 'Total', 'Line Items Count', 'Anomalies', 'Processed At', 'File Name'];
    const rows = invoices.map(inv => {
      const d = inv.data || {};
      return [
        inv.id,
        d.vendorName || '',
        d.invoiceNumber || '',
        d.date || '',
        d.poNumber || '',
        d.subtotal ?? '',
        d.tax ?? '',
        d.total ?? '',
        (d.lineItems || []).length,
        (d.anomalies || []).join('; '),
        inv.processedAt,
        inv.fileName
      ].map(escapeCSV).join(',');
    });
    
    const csv = [headers.join(','), ...rows].join('\n');
    
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="shieldinvoice-export.csv"',
        ...CORS_HEADERS,
      },
    });
    
  } catch (err) {
    console.error('Export error:', err);
    return json({ error: 'Export failed', message: err.message }, 500);
  }
}
