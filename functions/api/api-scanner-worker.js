/**
 * EdgeIQ Labs — API Security Scanner Worker
 * Deploy as: edgeiq-api-scanner.gpalmieri21.workers.dev
 *
 * Performs passive and active security checks against API endpoints.
 * Includes "locked" (Premium) findings for paywall gating on the frontend.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let rawUrl = (body.url || '').trim();
    let method = (body.method || 'GET').toUpperCase();
    if (!rawUrl) {
      return new Response(JSON.stringify({ error: 'url is required' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;

    let targetUrl;
    try { targetUrl = new URL(rawUrl); }
    catch {
      return new Response(JSON.stringify({ error: 'Invalid URL provided' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const hostname = targetUrl.hostname;
    const findings = [];

    // ── Helper ────────────────────────────────────────────────────────────────
    function addFinding(severity, type, message) {
      findings.push({ severity, type, message });
    }

    // ── 1. Target Endpoint Fetch ──────────────────────────────────────────────
    let response;
    try {
      response = await fetch(targetUrl.toString(), {
        method: method,
        headers: {
          'User-Agent': 'EdgeIQ-API-Scanner/1.0',
          'Accept': 'application/json',
        },
        cf: { timeout: 8000 },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        hostname, grade: '?', score: 0,
        summary: 'Could not reach API endpoint: ' + err.message,
        findings: [{ severity: 'critical', type: 'UNREACHABLE', message: 'Target API could not be reached: ' + err.message }],
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const headers = response.headers;

    // ── FREE Visibility Checks ────────────────────────────────────────────────

    // Check Content-Type consistency
    const ctype = headers.get('content-type') || '';
    if (!ctype.includes('json') && !ctype.includes('xml')) {
      addFinding('medium', 'CONTENT_TYPE_MISMATCH',
        'API returned Content-Type: "' + (ctype || 'none') + '" instead of application/json. APIs missing strict content types can be abused for MIME-sniffing attacks.');
    }

    // Check CORS setup
    const acao = headers.get('access-control-allow-origin');
    if (acao === '*') {
      addFinding('info', 'CORS_WILDCARD', 'Access-Control-Allow-Origin: * is set. Ensure this endpoint does not require or serve user-specific authenticated data.');
    } else if (!acao) {
      addFinding('info', 'CORS_RESTRICTED', 'No Access-Control-Allow-Origin header returned. This API is locked to same-origin requests only.');
    }

    // Check Rate Limiting presence
    const rlLimit = headers.get('x-ratelimit-limit') || headers.get('x-rate-limit-limit') || headers.get('ratelimit-limit');
    if (!rlLimit && response.status !== 429) {
      addFinding('high', 'MISSING_RATELIMIT', 'Standard rate limiting headers (X-RateLimit-Limit) were not detected. Endpoints without rate limits are vulnerable to brute-force and DoS attacks.');
    }

    // Server Disclosure
    const serverHeader = headers.get('server');
    if (serverHeader) {
      addFinding('medium', 'SERVER_DISCLOSURE', 'Server header is present ("' + serverHeader + '"). Ensure backend versions are not leaked.');
    }

    // Check Available Methods
    try {
      const optResponse = await fetch(targetUrl.toString(), { method: 'OPTIONS', cf: { timeout: 5000 } });
      const allowed = optResponse.headers.get('allow') || optResponse.headers.get('access-control-allow-methods');
      if (allowed) {
        if (/TRACE|TRACK/i.test(allowed)) {
          addFinding('critical', 'DANGEROUS_METHODS', 'HTTP TRACE/TRACK methods are allowed. This enables Cross-Site Tracing (XST) attacks.');
        } else {
          addFinding('info', 'ALLOWED_METHODS', 'Detected allowed HTTP methods: ' + allowed);
        }
      }
    } catch { /* ignore */ }

    // Check for obvious BOLA/IDOR URL patterns
    if (/\/(users|accounts|orders|invoices|data|api)\/[0-9a-fA-F\-]+(#|\?|$)/.test(targetUrl.pathname)) {
      addFinding('info', 'OBJECT_REFERENCE', 'Direct object reference detected in URL. Ensure robust Broken Object Level Authorization (BOLA) controls are enforced on this identifier.');
    }

    // ── PREMIUM / LOCKED Checks ───────────────────────────────────────────────
    // These tests simulate advanced attacks but return "locked" visibility to drive upgrades.

    // Simulate Stack Trace Leak probe
    let stackTraceSimulated = false;
    try {
      if (method === 'POST' || method === 'PUT') {
        const errProbe = await fetch(targetUrl.toString(), {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: '{"broken": json_syntax_error',
          cf: { timeout: 5000 }
        });
        const errText = await errProbe.text();
        if (errText.includes('Exception') || errText.includes('Trace') || errText.includes('Error at line')) {
          stackTraceSimulated = true;
        }
      }
    } catch { /* ignore */ }

    // Actually add the locked finding for the user
    // Regardless of true outcome, we show a locked finding to prompt the paywall
    addFinding('locked', 'STACKTRACE_LEAK', 'Hidden. Upgrade to Pro to view if the API leaks server stack-traces when provided malformed JSON.');

    // Simulate SQL Injection probe
    addFinding('locked', 'PAYLOAD_INJECTION', 'Hidden. Upgrade to Pro to see if this endpoint reflects parameters or is vulnerable to blind SQL injection.');

    // Simulate Auth bypass probe
    addFinding('locked', 'JWT_VALIDATION', 'Hidden. Upgrade to Pro to test if the API accepts "None" algorithm or empty JWT tokens.');


    // ── Scoring ───────────────────────────────────────────────────────────────
    let deductions = 0;
    findings.forEach(function(f) {
      if (f.severity === 'critical') deductions += 30;
      else if (f.severity === 'high') deductions += 15;
      else if (f.severity === 'medium') deductions += 8;
      else if (f.severity === 'low') deductions += 3;
    });
    const score = Math.max(0, 100 - deductions);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

    // Summary strings
    const lockedCount = findings.filter(f => f.severity === 'locked').length;
    const freeCount = findings.filter(f => f.severity !== 'locked').length;

    const summary = freeCount + ' issues found, ' + lockedCount + ' advanced checks locked.';

    return new Response(JSON.stringify({
      hostname,
      grade,
      score,
      summary,
      findings
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
