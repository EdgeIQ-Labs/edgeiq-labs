/**
 * GET /api/cert-expiry?domain=example.com
 *
 * Performs a TLS handshake and extracts certificate expiry date.
 * Uses CF Workers' connect() API for raw TCP socket access.
 *
 * Returns: { domain, expiry_date, days_until_expiry, issuer, subject, status }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/**
 * Parse X.509 certificate from DER-encoded TLS ServerHello.
 * Extracts notAfter date and issuer/subject CN.
 * This is a minimal ASN.1 DER parser — only handles what we need.
 */
function parseX509Expiry(derBytes) {
  try {
    // Find the Validity sequence in the certificate
    // X.509 structure: Certificate -> TBSCertificate -> Validity -> notBefore, notAfter
    // We search for the UTCTime or GeneralizedTime tag patterns

    const bytes = new Uint8Array(derBytes);
    let pos = 0;

    // Helper: read ASN.1 tag + length
    function readTagLength(offset) {
      if (offset >= bytes.length) return null;
      const tag = bytes[offset];
      offset++;
      let length = bytes[offset];
      offset++;
      if (length & 0x80) {
        const numLenBytes = length & 0x7f;
        length = 0;
        for (let i = 0; i < numLenBytes; i++) {
          length = (length << 8) | bytes[offset++];
        }
      }
      return { tag, length, offset };
    }

    // Search for UTCTime (tag 0x17) or GeneralizedTime (tag 0x18)
    // within the certificate structure
    const times = [];
    let searchPos = 0;
    while (searchPos < bytes.length - 2) {
      const tag = bytes[searchPos];
      if (tag === 0x17 || tag === 0x18) {
        // Potential time value
        const tl = readTagLength(searchPos);
        if (tl && tl.length > 0 && tl.length < 30 && tl.offset + tl.length <= bytes.length) {
          const timeStr = String.fromCharCode(...bytes.slice(tl.offset, tl.offset + tl.length));
          // Validate it looks like a date string
          if (/^\d{2}\d{2}\d{2}\d{2}\d{2}\d{2}Z$/.test(timeStr) || /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(timeStr)) {
            times.push({ type: tag === 0x17 ? 'utc' : 'gen', value: timeStr });
          }
        }
      }
      searchPos++;
    }

    if (times.length < 2) return null;

    // First time is notBefore, second is notAfter
    const notAfterRaw = times[1].value;
    let expiryDate;

    if (times[1].type === 'utc') {
      // UTCTime: YYMMDDHHmmssZ
      const yy = parseInt(notAfterRaw.slice(0, 2));
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      const month = notAfterRaw.slice(2, 4);
      const day = notAfterRaw.slice(4, 6);
      const hour = notAfterRaw.slice(6, 8);
      const min = notAfterRaw.slice(8, 10);
      const sec = notAfterRaw.slice(10, 12);
      expiryDate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    } else {
      // GeneralizedTime: YYYYMMDDHHmmssZ
      const year = notAfterRaw.slice(0, 4);
      const month = notAfterRaw.slice(4, 6);
      const day = notAfterRaw.slice(6, 8);
      const hour = notAfterRaw.slice(8, 10);
      const min = notAfterRaw.slice(10, 12);
      const sec = notAfterRaw.slice(12, 14);
      expiryDate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
    }

    if (isNaN(expiryDate.getTime())) return null;

    // Try to extract issuer CN (search for OID 2.5.4.3 = cn)
    let issuer = 'Unknown';
    const cnOid = [0x55, 0x04, 0x03]; // OID for commonName
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === cnOid[0] && bytes[i+1] === cnOid[1] && bytes[i+2] === cnOid[2]) {
        // Found CN OID, next should be UTF8String (0x0C) or PrintableString (0x13)
        const nextTag = bytes[i + 3];
        if (nextTag === 0x0C || nextTag === 0x13) {
          const len = bytes[i + 4];
          if (len > 0 && len < 100 && i + 5 + len <= bytes.length) {
            issuer = String.fromCharCode(...bytes.slice(i + 5, i + 5 + len));
            break;
          }
        }
      }
    }

    return { expiry_date: expiryDate.toISOString(), issuer };
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  if (!domain || !domain.includes('.')) {
    return json({ error: 'Valid domain required' }, 400);
  }

  try {
    // Use CF Workers connect() for raw TCP+TLS
    const socket = await connect(`${domain}:443`, { secureTransport: 'on' });
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();

    // Send ClientHello (minimal TLS 1.2 handshake)
    // This triggers the server to send its certificate
    const clientHello = buildClientHello(domain);
    await writer.write(clientHello);

    // Read response — we need enough bytes to capture the certificate
    let totalBytes = new Uint8Array(0);
    const maxRead = 16384; // Read up to 16KB
    let bytesRead = 0;

    while (bytesRead < maxRead) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]);
      if (done || !value) break;

      const newTotal = new Uint8Array(totalBytes.length + value.length);
      newTotal.set(totalBytes);
      newTotal.set(value, totalBytes.length);
      totalBytes = newTotal;
      bytesRead += value.length;

      // Stop early if we have enough (cert is usually in first few KB)
      if (bytesRead > 4096) break;
    }

    await reader.cancel();
    await writer.close();

    // Parse certificate from TLS ServerHello
    const certInfo = parseX509Expiry(totalBytes);

    if (!certInfo) {
      return json({ domain, status: 'error', error: 'Could not parse certificate' });
    }

    const now = new Date();
    const expiry = new Date(certInfo.expiry_date);
    const daysUntilExpiry = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

    let status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    return json({
      domain,
      status,
      expiry_date: certInfo.expiry_date,
      days_until_expiry: daysUntilExpiry,
      issuer: certInfo.issuer,
    });
  } catch (e) {
    return json({ domain, status: 'error', error: e.message });
  }
}

/**
 * Build a minimal TLS 1.2 ClientHello message.
 * Includes SNI extension for virtual hosting support.
 */
function buildClientHello(hostname) {
  // SNI extension
  const hostnameBytes = new TextEncoder().encode(hostname);
  const sniListLen = hostnameBytes.length + 3; // type(1) + len(2) + name
  const sniExtLen = sniListLen + 2; // list_len(2) + list
  const sniExtension = new Uint8Array([
    0x00, 0x00, // Extension type: server_name
    (sniExtLen >> 8) & 0xff, sniExtLen & 0xff, // Extension length
    (sniListLen >> 8) & 0xff, sniListLen & 0xff, // Server name list length
    0x00, // Name type: host_name
    (hostnameBytes.length >> 8) & 0xff, hostnameBytes.length & 0xff,
    ...hostnameBytes,
  ]);

  // Supported versions extension (TLS 1.2)
  const supportedVersions = new Uint8Array([
    0x00, 0x2b, // Extension type: supported_versions
    0x00, 0x03, // Extension length
    0x02,       // List length
    0x03, 0x03, // TLS 1.2
  ]);

  const extensions = new Uint8Array([...sniExtension, ...supportedVersions]);
  const extLen = extensions.length;

  // Cipher suites (just one: TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)
  const cipherSuites = new Uint8Array([
    0x00, 0x02, // Length
    0xc0, 0x2f, // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  ]);

  // Compression methods
  const compression = new Uint8Array([0x01, 0x00]); // null compression

  // Random (32 bytes)
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);

  // Session ID (empty)
  const sessionId = new Uint8Array([0x00]);

  // ClientHello body
  const body = new Uint8Array([
    0x03, 0x03, // Version: TLS 1.2
    ...random,
    ...sessionId,
    ...cipherSuites,
    ...compression,
    (extLen >> 8) & 0xff, extLen & 0xff,
    ...extensions,
  ]);

  // Handshake header
  const handshake = new Uint8Array([
    0x01, // Type: ClientHello
    0x00, (body.length >> 8) & 0xff, body.length & 0xff, // Length
    ...body,
  ]);

  // TLS record header
  const record = new Uint8Array([
    0x16, // Content type: Handshake
    0x03, 0x01, // Version: TLS 1.0 (for compatibility)
    (handshake.length >> 8) & 0xff, handshake.length & 0xff,
    ...handshake,
  ]);

  return record;
}
