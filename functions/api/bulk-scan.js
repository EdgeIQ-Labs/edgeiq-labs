// EdgeIQ Labs — Bulk Domain Security Scanner API
// POST /api/bulk-scan
// Accepts: { domains: string[] } (max 20)
// Returns: { results: [{ domain, grade, checks, issues, worst }] }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

// ── Individual check functions ──────────────────────────────────────

async function checkSSL(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    // If we got here over HTTPS without error, cert is valid enough
    return { pass: true, detail: 'Valid SSL certificate' };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { pass: false, detail: 'Connection timed out' };
    }
    return { pass: false, detail: e.message || 'SSL/TLS error' };
  }
}

async function checkHeaders(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);
    const headers = resp.headers;
    const missing = [];
    if (!headers.get('x-frame-options')) missing.push('X-Frame-Options');
    if (!headers.get('content-security-policy')) missing.push('CSP');
    if (!headers.get('strict-transport-security')) missing.push('HSTS');
    if (!headers.get('x-content-type-options')) missing.push('X-Content-Type-Options');
    if (missing.length === 0) {
      return { pass: true, detail: 'All security headers present' };
    }
    return { pass: false, detail: `Missing: ${missing.join(', ')}` };
  } catch (e) {
    return { pass: false, detail: 'Could not fetch headers' };
  }
}

async function dnsTxtLookup(name) {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/dns-json' }
    });
    const data = await resp.json();
    if (!data.Answer || data.Answer.length === 0) return null;
    return data.Answer.map(a => a.data.replace(/"/g, ''));
  } catch {
    return null;
  }
}

async function checkSPF(domain) {
  const records = await dnsTxtLookup(domain);
  if (!records) return { pass: false, detail: 'No DNS TXT records found' };
  const spf = records.find(r => r.startsWith('v=spf1'));
  if (!spf) return { pass: false, detail: 'No SPF record found' };
  return { pass: true, detail: 'SPF record present' };
}

async function checkDMARC(domain) {
  const records = await dnsTxtLookup(`_dmarc.${domain}`);
  if (!records) return { pass: false, detail: 'No DMARC record found' };
  const dmarc = records.find(r => r.startsWith('v=DMARC1'));
  if (!dmarc) return { pass: false, detail: 'No valid DMARC record' };
  return { pass: true, detail: 'DMARC record present' };
}

// ── Grade calculation ───────────────────────────────────────────────

function calculateGrade(checks) {
  const issues = [];
  let failCount = 0;

  for (const [key, result] of Object.entries(checks)) {
    if (result.status === 'skipped') continue;
    if (!result.pass) {
      failCount++;
      issues.push(`${key.toUpperCase()}: ${result.detail}`);
    }
  }

  let grade;
  if (failCount === 0) grade = 'A';
  else if (failCount === 1) grade = 'B';
  else if (failCount === 2) grade = 'C';
  else if (failCount === 3) grade = 'D';
  else grade = 'F';

  return { grade, issues, worst: issues[0] || 'None' };
}

// ── Scan single domain ──────────────────────────────────────────────

async function scanDomain(domain) {
  const results = await Promise.allSettled([
    checkSSL(domain),
    checkHeaders(domain),
    checkSPF(domain),
    checkDMARC(domain)
  ]);

  const unwrap = (r) => r.status === 'fulfilled' ? r.value : { pass: false, detail: 'Check failed' };

  const checks = {
    ssl: unwrap(results[0]),
    headers: unwrap(results[1]),
    spf: unwrap(results[2]),
    dmarc: unwrap(results[3]),
    blacklist: { status: 'skipped', pass: null, detail: 'Skipped (MVP)' }
  };

  const { grade, issues, worst } = calculateGrade(checks);

  return { domain, grade, checks, issues, worst };
}

// ── Request handler ─────────────────────────────────────────────────

export async function onRequest(context) {
  const { request } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return jsonResp({ error: 'Method not allowed. Use POST.' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.domains || !Array.isArray(body.domains)) {
    return jsonResp({ error: 'Missing or invalid "domains" array' }, 400);
  }

  // Sanitize and cap
  const domains = body.domains
    .map(d => typeof d === 'string' ? d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*/, '') : '')
    .filter(d => d.length > 0 && /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}$/.test(d))
    .slice(0, 20);

  if (domains.length === 0) {
    return jsonResp({ error: 'No valid domains provided' }, 400);
  }

  // Run all scans in parallel
  const scanResults = await Promise.allSettled(domains.map(scanDomain));
  const results = scanResults.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      domain: domains[i],
      grade: 'F',
      checks: {
        ssl: { pass: false, detail: 'Scan failed' },
        headers: { pass: false, detail: 'Scan failed' },
        spf: { pass: false, detail: 'Scan failed' },
        dmarc: { pass: false, detail: 'Scan failed' },
        blacklist: { status: 'skipped', pass: null, detail: 'Skipped (MVP)' }
      },
      issues: ['Domain unreachable'],
      worst: 'Domain unreachable'
    };
  });

  return jsonResp({ results });
}
