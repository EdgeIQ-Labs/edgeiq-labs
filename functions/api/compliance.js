/**
 * GET /api/compliance?domain=…&framework=soc2|hipaa|pci
 *
 * Live compliance scanner — performs real DNS + HTTP header checks
 * against the target domain and maps findings to control frameworks.
 *
 * Checks performed:
 *   DNS    : SPF (TXT), DMARC (TXT + policy level), MX records
 *   HTTPS  : TLS reachability, HTTP→HTTPS redirect, HSTS (+ max-age)
 *   Headers: Content-Security-Policy, X-Frame-Options, X-Content-Type-Options,
 *            Referrer-Policy, Permissions-Policy, Server, X-Powered-By
 *   Cookies: Secure + HttpOnly flags when Set-Cookie is observed
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DOH           = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS    = 8000;
const UA            = 'EdgeIQ-Compliance-Scanner/1.0';

// ── DNS helpers ───────────────────────────────────────────────────────────────

async function dnsQuery(name, type) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}

function parseTxt(raw) {
  // DoH returns TXT data as "part1" "part2" — strip quotes and join.
  return (raw || '').replace(/^"|"$/g, '').replace(/" "/g, '');
}

function getTxtValues(resp) {
  return (resp.Answer || [])
    .filter(a => a.type === 16)                  // TXT = 16
    .map(a => parseTxt(a.data || ''));
}

function hasMx(resp) {
  return resp.Status === 0 && (resp.Answer || []).some(a => a.type === 15); // MX = 15
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function safeFetch(url, opts = {}) {
  const method = opts.method || 'HEAD';
  try {
    const r = await fetch(url, {
      ...opts,
      method,
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Some servers block HEAD — retry with GET
    if (r.status === 405 && method === 'HEAD') {
      return await fetch(url, {
        ...opts,
        method: 'GET',
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
    return r;
  } catch {
    return null;
  }
}

// ── Control evaluators ────────────────────────────────────────────────────────
// Each receives the full `checks` bundle and returns { score: 0–1, action: string }

function evalCC61({ httpsWorks, hsts, httpPortOpen, httpRedirectsToHttps }) {
  let score = 0;
  const issues = [];
  if (httpsWorks)                            { score += 0.40; }
  else { issues.push('HTTPS is not working — domain is unreachable over TLS'); }
  if (hsts)                                  { score += 0.35; }
  else { issues.push('Missing Strict-Transport-Security (HSTS) header — add with max-age ≥ 31536000'); }
  if (!httpPortOpen || httpRedirectsToHttps) { score += 0.25; }
  else { issues.push('HTTP port 80 is open but does not redirect to HTTPS — add a 301 redirect'); }
  const action = issues.length
    ? issues[0] + (issues.length > 1 ? ` (+${issues.length - 1} more issue)` : '')
    : 'HTTPS active, HSTS configured, and HTTP redirects to HTTPS.';
  return { score, action };
}

function evalCC62({ xFrameOptions, cspFrameAncestors, xContentTypeOptions }) {
  let score = 0;
  const issues = [];
  if (xFrameOptions || cspFrameAncestors) { score += 0.55; }
  else { issues.push('No clickjacking protection — add X-Frame-Options: DENY or CSP frame-ancestors directive'); }
  if (xContentTypeOptions)               { score += 0.45; }
  else { issues.push('Missing X-Content-Type-Options: nosniff — prevents MIME-type confusion attacks'); }
  const action = issues.length ? issues[0] : 'Clickjacking and content-type protections are in place.';
  return { score, action };
}

function evalCC66({ referrerPolicy, permissionsPolicy, cookiesSeen, cookiesSecure, cookiesHttpOnly }) {
  let score = 0;
  const issues = [];
  if (referrerPolicy)    { score += 0.35; }
  else { issues.push('Missing Referrer-Policy header — request referrers leak URL data to third parties'); }
  if (permissionsPolicy) { score += 0.30; }
  else { issues.push('Missing Permissions-Policy — browser feature access (camera, mic, geolocation) is unrestricted'); }
  if (cookiesSeen) {
    if (cookiesSecure)   { score += 0.175; }
    else { issues.push('Session cookie missing Secure flag — cookie transmitted over plain HTTP'); }
    if (cookiesHttpOnly) { score += 0.175; }
    else { issues.push('Session cookie missing HttpOnly flag — accessible via JavaScript (XSS risk)'); }
  } else {
    score += 0.35; // No cookies observed on homepage — treat as neutral
  }
  const action = issues.length ? issues[0] : 'Referrer-Policy, Permissions-Policy, and cookie security flags are correctly set.';
  return { score, action };
}

function evalCC72({ serverHeader, serverVersionLeaks, xPoweredBy, xPoweredByPresent }) {
  let score = 0;
  const issues = [];
  if (!serverVersionLeaks)  { score += 0.50; }
  else { issues.push(`Server header reveals software version ("${serverHeader.slice(0, 40)}") — generalize or remove it`); }
  if (!xPoweredByPresent)   { score += 0.50; }
  else { issues.push(`X-Powered-By exposes framework info ("${xPoweredBy.slice(0, 40)}") — remove this response header`); }
  const action = issues.length ? issues[0] : 'No server or framework version information exposed in response headers.';
  return { score, action };
}

function evalCC81({ spfPresent, dmarcPresent }) {
  let score = 0;
  const issues = [];
  if (spfPresent)   { score += 0.50; }
  else { issues.push('No SPF TXT record found — your domain can be spoofed in phishing/spam emails'); }
  if (dmarcPresent) { score += 0.50; }
  else { issues.push('No DMARC record found — no email authentication policy is defined for this domain'); }
  const action = issues.length ? issues[0] : 'SPF and DMARC records are present — email authentication is configured.';
  return { score, action };
}

function evalA1({ cspPresent, cspHasDefaultSrc, cspHasScriptSrc }) {
  let score = 0;
  const issues = [];
  if (cspPresent) {
    score += 0.45;
    if (cspHasDefaultSrc || cspHasScriptSrc) { score += 0.55; }
    else { score += 0.20; issues.push('CSP present but lacks default-src or script-src — tighten the policy to block inline scripts'); }
  } else {
    issues.push('No Content-Security-Policy header — no browser-level defence against script injection (XSS)');
  }
  const action = issues.length ? issues[0] : 'Content-Security-Policy is configured with script-src directives.';
  return { score, action };
}

function evalA3({ httpsWorks, hsts, hstsLongAge, httpPortOpen, httpRedirectsToHttps }) {
  let score = 0;
  const issues = [];
  if (httpsWorks)                            { score += 0.45; }
  else { issues.push('HTTPS not working — data-in-transit integrity cannot be enforced without TLS'); }
  if (hstsLongAge)                           { score += 0.35; }
  else if (hsts) { score += 0.15; issues.push('HSTS max-age is below 1 year — set to at least max-age=31536000 to prevent downgrade attacks'); }
  else { issues.push('No HSTS header — browsers can be downgraded to unencrypted HTTP'); }
  if (!httpPortOpen || httpRedirectsToHttps) { score += 0.20; }
  else { issues.push('Plain HTTP is served without redirecting to HTTPS — all traffic should be encrypted'); }
  const action = issues.length ? issues[0] : 'TLS is active, HSTS is long-lived, and HTTP traffic redirects to HTTPS.';
  return { score, action };
}

function evalA5({ spfPresent, dmarcPresent, dmarcStrictPolicy, mxPresent }) {
  let score = 0;
  const issues = [];
  if (mxPresent)             { score += 0.25; }
  else { issues.push('No MX records found — mail delivery infrastructure is missing or misconfigured'); }
  if (spfPresent)            { score += 0.25; }
  else { issues.push('No SPF record — email origin cannot be verified; enables phishing'); }
  if (dmarcStrictPolicy)     { score += 0.50; }
  else if (dmarcPresent)     { score += 0.20; issues.push('DMARC policy is p=none — no enforcement; upgrade to p=quarantine or p=reject'); }
  else { issues.push('No DMARC record — failed auth emails are not quarantined or rejected'); }
  const action = issues.length ? issues[0] : 'MX, SPF, and DMARC (enforced) are all correctly configured.';
  return { score, action };
}

// ── Control catalogue ─────────────────────────────────────────────────────────

const CONTROLS = {
  soc2: [
    { id: 'CC6.1', name: 'Logical and Physical Access Controls', category: 'Security',             fn: evalCC61 },
    { id: 'CC6.2', name: 'Logical Access Controls',              category: 'Security',             fn: evalCC62 },
    { id: 'CC6.6', name: 'Security for Remote Computing',        category: 'Security',             fn: evalCC66 },
    { id: 'CC7.2', name: 'Vulnerability Management',             category: 'Monitoring',           fn: evalCC72 },
    { id: 'CC8.1', name: 'Change Management',                    category: 'Operations',           fn: evalCC81 },
    { id: 'A1',    name: 'Injection',                            category: 'Application Security', fn: evalA1   },
    { id: 'A3',    name: 'Data Integrity',                       category: 'Data Protection',      fn: evalA3   },
    { id: 'A5',    name: 'Logging and Monitoring',               category: 'Monitoring',           fn: evalA5   },
  ],
  hipaa: [
    { id: '164.312(a)(1)', name: 'Access Control',                     category: 'Technical',      fn: evalCC61 },
    { id: '164.312(c)(1)', name: 'Integrity Controls',                 category: 'Technical',      fn: evalA3   },
    { id: '164.308(a)(5)', name: 'Protection from Malicious Software', category: 'Administrative', fn: evalCC72 },
  ],
  pci: [
    { id: 'Req 1',  name: 'Network Security Controls',   category: 'Network',  fn: evalCC61 },
    { id: 'Req 6',  name: 'Secure Systems and Software', category: 'Software', fn: evalA1   },
    { id: 'Req 11', name: 'Regular Testing',             category: 'Testing',  fn: evalCC72 },
  ],
};

const DISPLAY_NAME = { soc2: 'SOC 2', hipaa: 'HIPAA', pci: 'PCI-DSS' };

// ── Grade / status helpers ────────────────────────────────────────────────────

function gradeFromScore(s) {
  if (s >= 90) return 'A';
  if (s >= 70) return 'B';
  if (s >= 50) return 'C';
  if (s >= 30) return 'D';
  return 'F';
}

function statusFromRatio(r) {
  if (r >= 0.80) return 'pass';
  if (r >= 0.40) return 'warning';
  return 'fail';
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Entry points ──────────────────────────────────────────────────────────────

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
  const framework = (url.searchParams.get('framework') || 'soc2').trim().toLowerCase();

  if (!domain || !/^[a-z0-9][a-z0-9\-\.]{1,61}[a-z0-9]\.[a-z]{2,}$/.test(domain)) {
    return jsonResp({ error: 'invalid_domain', message: 'Provide a valid domain (e.g. example.com).' }, 400);
  }
  const controls = CONTROLS[framework];
  if (!controls) {
    return jsonResp({ error: 'invalid_framework', message: 'Supported frameworks: soc2, hipaa, pci.' }, 400);
  }

  // ── Run all probes in parallel ────────────────────────────────────────────

  const [httpsResp, httpResp, txtRoot, txtDmarc, mxResp] = await Promise.all([
    safeFetch(`https://${domain}`, { method: 'HEAD', redirect: 'follow' }),
    safeFetch(`http://${domain}`,  { method: 'GET',  redirect: 'follow' }),
    dnsQuery(domain,              'TXT'),
    dnsQuery(`_dmarc.${domain}`,  'TXT'),
    dnsQuery(domain,              'MX'),
  ]);

  // ── Interpret HTTP/S results ──────────────────────────────────────────────

  const httpsWorks = !!(httpsResp && httpsResp.ok && httpsResp.status >= 200 && httpsResp.status < 400);
  const hdrs       = httpsResp ? httpsResp.headers : new Headers();

  // HTTP port open = we got any response (even 4xx means port 80 is reachable)
  const httpPortOpen          = !!(httpResp && httpResp.status > 0);
  // redirect: 'follow' resolves the final URL — if it starts https://, a redirect happened
  const httpRedirectsToHttps  = !!(httpResp && (httpResp.url || '').startsWith('https://'));

  // HSTS
  const hstsRaw    = hdrs.get('strict-transport-security') || '';
  const hsts       = hstsRaw.length > 0;
  const m          = hstsRaw.match(/max-age=(\d+)/i);
  const hstsMaxAge = m ? parseInt(m[1], 10) : 0;
  const hstsLongAge = hstsMaxAge >= 31536000; // ≥ 1 year

  // CSP
  const cspRaw           = hdrs.get('content-security-policy') || '';
  const cspPresent       = cspRaw.length > 0;
  const cspLow           = cspRaw.toLowerCase();
  const cspHasDefaultSrc = cspLow.includes('default-src');
  const cspHasScriptSrc  = cspLow.includes('script-src');
  const cspFrameAncestors= cspLow.includes('frame-ancestors');

  // Framing + MIME
  const xFrameOptions      = (hdrs.get('x-frame-options') || '').length > 0;
  const xContentTypeOptions = /nosniff/i.test(hdrs.get('x-content-type-options') || '');

  // Remote security
  const referrerPolicy   = (hdrs.get('referrer-policy') || '').length > 0;
  const permissionsPolicy = (
    (hdrs.get('permissions-policy') || '').length > 0 ||
    (hdrs.get('feature-policy')     || '').length > 0
  );

  // Server info leakage
  const serverHeader       = hdrs.get('server') || '';
  const serverVersionLeaks = serverHeader.length > 0 && (
    /[\d\.]{3,}/.test(serverHeader) ||
    /apache|nginx|iis|litespeed|openresty|caddy|gunicorn|uvicorn|tornado/i.test(serverHeader)
  );
  const xPoweredBy         = hdrs.get('x-powered-by') || '';
  const xPoweredByPresent  = xPoweredBy.length > 0;

  // Cookies (only from the HTTPS homepage response — HEAD may not return Set-Cookie)
  const setCookie       = hdrs.get('set-cookie') || '';
  const cookiesSeen     = setCookie.length > 0;
  const cookiesSecure   = !cookiesSeen || /\bsecure\b/i.test(setCookie);
  const cookiesHttpOnly = !cookiesSeen || /\bhttponly\b/i.test(setCookie);

  // DNS
  const txtVals    = getTxtValues(txtRoot);
  const spfPresent = txtVals.some(t => /^v=spf1\b/i.test(t));

  const dmarcVals        = getTxtValues(txtDmarc);
  const dmarcPresent     = dmarcVals.some(t => /^v=DMARC1\b/i.test(t));
  const dmarcStrictPolicy= dmarcVals.some(t => /p=(quarantine|reject)/i.test(t));

  const mxPresent = hasMx(mxResp);

  // ── Checks bundle ─────────────────────────────────────────────────────────

  const checks = {
    httpsWorks, httpPortOpen, httpRedirectsToHttps,
    hsts, hstsLongAge,
    cspPresent, cspHasDefaultSrc, cspHasScriptSrc, cspFrameAncestors,
    xFrameOptions, xContentTypeOptions,
    referrerPolicy, permissionsPolicy,
    serverHeader, serverVersionLeaks,
    xPoweredBy, xPoweredByPresent,
    cookiesSeen, cookiesSecure, cookiesHttpOnly,
    spfPresent, dmarcPresent, dmarcStrictPolicy,
    mxPresent,
  };

  // ── Evaluate controls ─────────────────────────────────────────────────────

  const results = controls.map(ctrl => {
    const { score, action } = ctrl.fn(checks);
    return {
      id:       ctrl.id,
      name:     ctrl.name,
      category: ctrl.category,
      status:   statusFromRatio(score),
      score:    Math.round(score * 100),
      action,
    };
  });

  const passed  = results.filter(r => r.status === 'pass').length;
  const warning = results.filter(r => r.status === 'warning').length;
  const failed  = results.filter(r => r.status === 'fail').length;

  // Overall score = average of per-control scores
  const avgScore = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const grade    = gradeFromScore(avgScore);

  return jsonResp({
    domain,
    framework:      DISPLAY_NAME[framework] || framework.toUpperCase(),
    score:          avgScore,
    grade,
    total_controls: results.length,
    passed,
    warning,
    failed,
    controls:       results,
    scanned_at:     new Date().toISOString(),
  });
}
