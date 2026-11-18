/**
 * Compliance Evidence Collector — Export Audit Bundle
 * POST /api/evidence-collector/export
 * Body: { org_id, controls: ["HIPAA_164.308", ...] }
 * 
 * Generates a ZIP bundle containing:
 *   - cover_sheet.txt (audit metadata)
 *   - {control_id}/ folder per control
 *   - All evidence files organized by control
 * 
 * Auth: X-Evidence-Token header
 * Returns: application/zip stream
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Evidence-Token',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(atob(parts[0]));
    if (!payload.org || !payload.role || payload.role !== 'manager') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    const expected = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.EVIDENCE_JWT_SECRET || env.TRAINING_JWT_SECRET || 'fallback'),
      'HMAC', false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign(
      'HMAC', expected, new TextEncoder().encode(parts[0])
    ));
    const provided = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0));
    if (sig.length !== provided.length) return null;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] !== provided[i]) return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// Minimal ZIP implementation (no external deps)
function createZip(files) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = file.data instanceof Uint8Array ? file.data : new TextEncoder().encode(file.data);
    
    // Local file header
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression (none)
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, 0, true); // crc32 (skip for simplicity)
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);
    localHeaders.push(localHeader, dataBytes);

    // Central directory header
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, 0, true); // crc32
    cv.setUint32(20, dataBytes.length, true); // compressed size
    cv.setUint32(24, dataBytes.length, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // name length
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset
    centralHeader.set(nameBytes, 46);
    centralHeaders.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) centralDirSize += ch.length;

  // End of central directory
  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localHeaders, ...centralHeaders, endRecord], { type: 'application/zip' });
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (context.request.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  const token = context.request.headers.get('X-Evidence-Token');
  const manager = await verifyToken(token, context.env);
  if (!manager) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const body = await context.request.json();
    const orgId = body.org_id || manager.org;
    const controlFilter = body.controls || null;

    // Fetch all evidence for org
    const indexKey = `evidence:index:${orgId}`;
    const index = (await context.env.COMPLIANCE_KV.get(indexKey, 'json')) || [];

    let filtered = index;
    if (controlFilter && controlFilter.length > 0) {
      filtered = index.filter(e => controlFilter.includes(e.control_id));
    }

    if (filtered.length === 0) {
      return json({ error: 'No evidence found for export' }, 404);
    }

    // Build ZIP contents
    const zipFiles = [];

    // Cover sheet
    const coverSheet = [
      '═══════════════════════════════════════════════════════════',
      '           EDGEIQ LABS COMPLIANCE EVIDENCE BUNDLE',
      '═══════════════════════════════════════════════════════════',
      '',
      `Organization: ${orgId}`,
      `Generated: ${new Date().toISOString()}`,
      `Total Evidence Items: ${filtered.length}`,
      `Controls Covered: ${new Set(filtered.map(e => e.control_id)).size}`,
      '',
      '───────────────────────────────────────────────────────────',
      'CONTENTS:',
      '───────────────────────────────────────────────────────────',
      ...filtered.map(e => `  ${e.control_id}/${e.filename} (${e.submitted_at})`),
      '',
      '───────────────────────────────────────────────────────────',
      'This bundle was generated by EdgeIQ Labs Compliance Evidence',
      'Collector. All evidence items are organized by control framework',
      'identifier for auditor review.',
      '',
      'For questions, contact support@edgeiqlabs.com',
      '═══════════════════════════════════════════════════════════',
    ].join('\n');
    zipFiles.push({ name: 'COVER_SHEET.txt', data: coverSheet });

    // Fetch each evidence record and add to ZIP
    for (const entry of filtered) {
      const recordRaw = await context.env.COMPLIANCE_KV.get(`evidence:${orgId}:${entry.id}`);
      if (!recordRaw) continue;
      
      try {
        const record = JSON.parse(recordRaw);
        if (record.data_base64) {
          const binary = atob(record.data_base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          
          const safeControlId = (record.control_id || 'UNTAGGED').replace(/[^a-zA-Z0-9_-]/g, '_');
          const safeFilename = (record.filename || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_');
          zipFiles.push({
            name: `${safeControlId}/${safeFilename}`,
            data: bytes,
          });
        }
      } catch {}
    }

    const zipBlob = createZip(zipFiles);
    const timestamp = new Date().toISOString().slice(0, 10);
    
    return new Response(zipBlob.stream(), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="compliance-evidence-${orgId}-${timestamp}.zip"`,
        ...CORS,
      },
    });

  } catch (e) {
    return json({ error: 'Export failed: ' + e.message }, 500);
  }
}
