/**
 * Secure Download Endpoint
 * GET /api/download?token=<signed_token>
 * 
 * Validates HMAC-SHA256 signature + expiry, decrements download counter,
 * and redirects to the actual file URL or serves from KV.
 */

const PRODUCT_FILES = {
  'hipaa-checklist': '/assets/downloads/hipaa-compliance-checklist-2026.pdf',
  'soc2-template': '/assets/downloads/soc2-readiness-template.pdf',
  'security-policy-bundle': '/assets/downloads/security-policy-bundle.zip',
  'geo-audit-guide': '/assets/downloads/geo-optimization-guide.pdf',
};

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [tokenId, expiresStr, providedSig] = parts;
  const expiresAt = parseInt(expiresStr, 10);

  // Check expiry
  if (Date.now() > expiresAt) return null;

  // Reconstruct expected signature
  // We need the original payload from KV to verify
  const recordJson = await arguments[2]?.PULSE_KV?.get(`digital:token:${tokenId}`);
  if (!recordJson) return null;

  const record = JSON.parse(recordJson);
  const payload = `${tokenId}:${record.productSlug}:${record.email}:${expiresAt}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (providedSig !== expectedSig) return null;

  return record;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Verify token
  const parts = token.split('.');
  if (parts.length !== 3) {
    return new Response(JSON.stringify({ error: 'Invalid token format' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const [tokenId, expiresStr, providedSig] = parts;
  const expiresAt = parseInt(expiresStr, 10);

  if (Date.now() > expiresAt) {
    return new Response(JSON.stringify({ error: 'Download link expired', expired: true }), {
      status: 410, headers: { 'Content-Type': 'application/json' }
    });
  }

  const recordJson = await env.PULSE_KV.get(`digital:token:${tokenId}`);
  if (!recordJson) {
    return new Response(JSON.stringify({ error: 'Invalid or used token' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }

  const record = JSON.parse(recordJson);
  const payload = `${tokenId}:${record.productSlug}:${record.email}:${expiresAt}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.STRIPE_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (providedSig !== expectedSig) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Check download count
  if (record.downloadsRemaining <= 0) {
    return new Response(JSON.stringify({ error: 'Download limit reached', limitReached: true }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Decrement download counter
  record.downloadsRemaining -= 1;
  await env.PULSE_KV.put(`digital:token:${tokenId}`, JSON.stringify(record));

  // Get file path
  const filePath = PRODUCT_FILES[record.productSlug];
  if (!filePath) {
    return new Response(JSON.stringify({ error: 'Product file not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Redirect to file (static asset served by CF Pages)
  const fileUrl = `https://edgeiqlabs.com${filePath}`;
  return new Response(null, {
    status: 302,
    headers: { 'Location': fileUrl, 'Cache-Control': 'no-store' }
  });
}
