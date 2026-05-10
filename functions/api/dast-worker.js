/**
 * EdgeIQ Labs — DAST Scanner Worker
 * Deploy as: edgeiq-dast-scanner.gpalmieri21.workers.dev
 *
 * Performs passive + light-active DAST checks against any public URL:
 *  - Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
 *  - CORS misconfiguration
 *  - Cookie security flags
 *  - Open redirect probe
 *  - Server/tech version disclosure
 *  - Mixed content indicators
 *  - robots.txt admin path leakage
 *  - Referrer-Policy, Permissions-Policy
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

    // ── Fetch the target page ─────────────────────────────────────────────────
    let response, responseText = '';
    try {
      response = await fetch(targetUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'EdgeIQ-DAST-Scanner/1.0 (security audit; contact security@edgeiqlabs.com)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        cf: { timeout: 10000 },
      });
      try { responseText = await response.text(); } catch { responseText = ''; }
    } catch (err) {
      return new Response(JSON.stringify({
        hostname, grade: '?', score: 0, checks_run: 0,
        summary: 'Could not reach target: ' + (err.message || 'Connection failed'),
        findings: [{ severity: 'critical', type: 'UNREACHABLE', message: 'Target URL could not be reached: ' + err.message }],
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const headers = response.headers;

    // ── 1. X-Frame-Options / frame-ancestors ──────────────────────────────────
    const xfo = headers.get('x-frame-options');
    const csp = headers.get('content-security-policy') || '';
    const hasFrameAncestors = /frame-ancestors/i.test(csp);
    if (!xfo && !hasFrameAncestors) {
      addFinding('high', 'CLICKJACKING',
        'X-Frame-Options header is missing and CSP frame-ancestors is not set. This page may be embeddable in an iframe, enabling clickjacking attacks.');
    }

    // ── 2. Content-Security-Policy ────────────────────────────────────────────
    if (!csp) {
      addFinding('high', 'NO_CSP',
        'Content-Security-Policy (CSP) header is missing. Without CSP, attackers can inject malicious scripts via XSS with no browser-level restriction.');
    } else {
      if (/unsafe-inline/i.test(csp)) {
        addFinding('medium', 'CSP_UNSAFE_INLINE',
          "CSP contains 'unsafe-inline' — inline scripts are allowed, which partially defeats XSS protection.");
      }
      if (/unsafe-eval/i.test(csp)) {
        addFinding('medium', 'CSP_UNSAFE_EVAL',
          "CSP contains 'unsafe-eval' — dynamic code execution (eval, Function()) is permitted.");
      }
    }

    // ── 3. HSTS ───────────────────────────────────────────────────────────────
    const hsts = headers.get('strict-transport-security');
    if (!hsts) {
      addFinding('high', 'NO_HSTS',
        'Strict-Transport-Security (HSTS) header is missing. Browsers may connect over plain HTTP, enabling MITM attacks and SSL-stripping.');
    } else {
      const maxAgeMatch = hsts.match(/max-age=(\d+)/i);
      if (maxAgeMatch && parseInt(maxAgeMatch[1]) < 2592000) {
        addFinding('medium', 'HSTS_SHORT_MAXAGE',
          'HSTS max-age is less than 30 days (' + maxAgeMatch[1] + 's). Recommended minimum is 1 year (31536000).');
      }
    }

    // ── 4. X-Content-Type-Options ─────────────────────────────────────────────
    const xcto = headers.get('x-content-type-options');
    if (!xcto || xcto.toLowerCase() !== 'nosniff') {
      addFinding('medium', 'MIME_SNIFFING',
        'X-Content-Type-Options: nosniff is missing. Browsers may MIME-sniff responses, which can enable MIME-type confusion attacks.');
    }

    // ── 5. Referrer-Policy ────────────────────────────────────────────────────
    const rp = headers.get('referrer-policy');
    if (!rp) {
      addFinding('medium', 'NO_REFERRER_POLICY',
        'Referrer-Policy header is missing. Full URLs (including query parameters with tokens) may be leaked to third-party sites via the Referer header.');
    } else if (/unsafe-url|no-referrer-when-downgrade/i.test(rp)) {
      addFinding('low', 'WEAK_REFERRER_POLICY',
        'Referrer-Policy is set to "' + rp + '" which may leak sensitive URL parameters to external sites.');
    }

    // ── 6. Permissions-Policy ─────────────────────────────────────────────────
    const pp = headers.get('permissions-policy') || headers.get('feature-policy');
    if (!pp) {
      addFinding('low', 'NO_PERMISSIONS_POLICY',
        'Permissions-Policy header is missing. Browser features (camera, microphone, geolocation) are not explicitly restricted for this origin.');
    }

    // ── 7. CORS misconfiguration ──────────────────────────────────────────────
    // Probe with a crafted Origin
    try {
      const corsProbe = await fetch(targetUrl.toString(), {
        method: 'GET',
        headers: {
          'Origin': 'https://evil-attacker.com',
          'User-Agent': 'EdgeIQ-DAST-Scanner/1.0',
        },
        cf: { timeout: 8000 },
      });
      const acao = corsProbe.headers.get('access-control-allow-origin');
      const acac = corsProbe.headers.get('access-control-allow-credentials');
      if (acao === '*' && acac && acac.toLowerCase() === 'true') {
        addFinding('critical', 'CORS_WILDCARD_WITH_CREDENTIALS',
          'CORS is misconfigured: Access-Control-Allow-Origin: * combined with Access-Control-Allow-Credentials: true allows cross-origin requests with user credentials from any origin.');
      } else if (acao === 'https://evil-attacker.com') {
        addFinding('high', 'CORS_ORIGIN_REFLECTION',
          'The server reflects any supplied Origin back in Access-Control-Allow-Origin. Attackers can make cross-origin authenticated requests from arbitrary domains.');
      } else if (acao === '*') {
        addFinding('info', 'CORS_WILDCARD',
          'Access-Control-Allow-Origin: * is set (without credentials). Public APIs: OK. If this serves authenticated content, verify credentials are not accessible cross-origin.');
      }
    } catch { /* CORS probe failed silently */ }

    // ── 8. Cookie flags ───────────────────────────────────────────────────────
    const setCookieHeaders = response.headers.getAll
      ? response.headers.getAll('set-cookie')
      : [response.headers.get('set-cookie')].filter(Boolean);

    let insecureCookies = 0, noHttpOnly = 0, noSameSite = 0;
    setCookieHeaders.forEach(function(cookie) {
      if (!cookie) return;
      if (!/secure/i.test(cookie)) insecureCookies++;
      if (!/httponly/i.test(cookie)) noHttpOnly++;
      if (!/samesite/i.test(cookie)) noSameSite++;
    });
    if (setCookieHeaders.length > 0) {
      if (insecureCookies > 0) {
        addFinding('high', 'COOKIE_NO_SECURE',
          insecureCookies + ' cookie(s) set without the Secure flag. These cookies are transmitted over plain HTTP, exposing session tokens to MITM attacks.');
      }
      if (noHttpOnly > 0) {
        addFinding('high', 'COOKIE_NO_HTTPONLY',
          noHttpOnly + ' cookie(s) set without the HttpOnly flag. These are accessible via JavaScript — if XSS occurs, session tokens can be stolen.');
      }
      if (noSameSite > 0) {
        addFinding('medium', 'COOKIE_NO_SAMESITE',
          noSameSite + ' cookie(s) set without the SameSite attribute. This may allow cross-site request forgery (CSRF) attacks.');
      }
    }

    // ── 9. Open redirect probe ────────────────────────────────────────────────
    try {
      const redirectUrl = new URL(targetUrl.toString());
      redirectUrl.searchParams.set('next', 'https://evil-attacker.com');
      redirectUrl.searchParams.set('redirect', 'https://evil-attacker.com');
      const redirProbe = await fetch(redirectUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'EdgeIQ-DAST-Scanner/1.0' },
        cf: { timeout: 6000 },
      });
      if ([301, 302, 303, 307, 308].includes(redirProbe.status)) {
        const loc = redirProbe.headers.get('location') || '';
        if (/evil-attacker\.com/i.test(loc)) {
          addFinding('high', 'OPEN_REDIRECT',
            'Potential open redirect detected: appending ?next=https://evil-attacker.com caused a ' + redirProbe.status + ' redirect to ' + loc + '. Attackers can abuse this for phishing by redirecting users through your trusted domain.');
        }
      }
    } catch { /* open redirect probe failed silently */ }

    // ── 10. Server version disclosure ─────────────────────────────────────────
    const serverHeader = headers.get('server') || '';
    const xPoweredBy = headers.get('x-powered-by') || '';

    const versionPattern = /[\d]+\.[\d]+/;
    if (versionPattern.test(serverHeader)) {
      addFinding('medium', 'SERVER_VERSION_DISCLOSURE',
        'Server header reveals version info: "' + serverHeader + '". Version disclosure helps attackers identify vulnerable software. Recommend suppressing or genericising this header.');
    } else if (serverHeader && !/^(cloudflare|nginx|apache|iis|openresty)$/i.test(serverHeader)) {
      addFinding('info', 'SERVER_HEADER',
        'Server header value: "' + serverHeader + '". Consider reviewing what this reveals about your stack.');
    }
    if (xPoweredBy) {
      addFinding('medium', 'XPOWEREDBY_DISCLOSURE',
        'X-Powered-By header is present: "' + xPoweredBy + '". This reveals your backend framework. Recommend removing this header.');
    }

    // ── 11. Mixed content & tech fingerprinting from HTML ─────────────────────
    if (responseText) {
      // Mixed content
      if (targetUrl.protocol === 'https:' && /src=["']http:\/\//i.test(responseText)) {
        addFinding('high', 'MIXED_CONTENT',
          'The page loads resources (scripts, images, or stylesheets) over HTTP despite being served over HTTPS. Mixed content can be intercepted and modified by MITM attackers.');
      }

      // Generator meta tag
      const genMatch = responseText.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
      if (genMatch) {
        addFinding('info', 'TECH_FINGERPRINT',
          'Generator meta tag reveals: "' + genMatch[1] + '". Consider removing this to reduce fingerprinting surface.');
      }

      // Admin paths in robots.txt
      if (/disallow.*\/(admin|wp-admin|dashboard|cpanel|phpmyadmin|manager|backend)/i.test(responseText)) {
        addFinding('info', 'ROBOTS_ADMIN_PATHS',
          'robots.txt contains Disallow entries pointing to admin or sensitive paths. While robots.txt is not a security control, it telegraphs sensitive endpoints to attackers who check it routinely.');
      }
    }

    // ── 12. robots.txt fetch ──────────────────────────────────────────────────
    try {
      const robotsUrl = new URL('/robots.txt', targetUrl.origin);
      const robotsResp = await fetch(robotsUrl.toString(), {
        cf: { timeout: 5000 },
        headers: { 'User-Agent': 'EdgeIQ-DAST-Scanner/1.0' },
      });
      if (robotsResp.ok) {
        const robotsTxt = await robotsResp.text();
        if (/disallow.*\/(admin|wp-admin|dashboard|cpanel|phpmyadmin|manager|backend)/i.test(robotsTxt)) {
          addFinding('info', 'ROBOTS_ADMIN_PATHS',
            'robots.txt disallows access to admin-like paths (/admin, /dashboard, etc.), effectively advertising their existence to attackers.');
        }
      }
    } catch { /* robots.txt fetch failed silently */ }

    // ── Scoring ───────────────────────────────────────────────────────────────
    let deductions = 0;
    findings.forEach(function(f) {
      if (f.severity === 'critical') deductions += 30;
      else if (f.severity === 'high') deductions += 15;
      else if (f.severity === 'medium') deductions += 8;
      else if (f.severity === 'low') deductions += 3;
      // info: 0 deduction
    });
    const score = Math.max(0, 100 - deductions);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

    const critCount = findings.filter(f => f.severity === 'critical').length;
    const highCount = findings.filter(f => f.severity === 'high').length;
    const medCount  = findings.filter(f => f.severity === 'medium').length;
    const lowCount  = findings.filter(f => f.severity === 'low').length;
    const infoCount = findings.filter(f => f.severity === 'info').length;

    let summaryParts = [];
    if (critCount) summaryParts.push(critCount + ' critical');
    if (highCount) summaryParts.push(highCount + ' high');
    if (medCount)  summaryParts.push(medCount + ' medium');
    if (lowCount)  summaryParts.push(lowCount + ' low');
    if (infoCount) summaryParts.push(infoCount + ' info');
    const summary = findings.length === 0
      ? 'No issues found — strong security posture'
      : summaryParts.join(', ') + ' — ' + findings.length + ' total finding' + (findings.length !== 1 ? 's' : '');

    const result = {
      hostname,
      grade,
      score,
      summary,
      checks_run: 12,
      findings,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
