/**
 * EdgeIQ — HTTP Security Header Analyzer
 * GET /api/header-check?domain=example.com
 *
 * Fetches the target URL and analyzes all security-relevant response headers.
 * Returns structured findings with pass/fail/warn status and recommendations.
 */

const SECURITY_HEADERS = {
  'strict-transport-security': {
    name: 'Strict-Transport-Security (HSTS)',
    category: 'encryption',
    weight: 20,
    check: (val) => {
      if (!val) return { status: 'fail', detail: 'Missing — browsers will allow HTTP connections', fix: 'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains' };
      const maxAge = val.match(/max-age=(\d+)/);
      const age = maxAge ? parseInt(maxAge[1]) : 0;
      const includeSub = val.includes('includeSubDomains');
      const preload = val.includes('preload');
      if (age >= 31536000 && includeSub) return { status: 'pass', detail: `HSTS active (${age.toLocaleString()}s)${preload ? ' + preload' : ''}${includeSub ? ' + includeSubDomains' : ''}`, value: val };
      if (age > 0) return { status: 'warn', detail: `HSTS set but max-age too low (${age.toLocaleString()}s). Recommend ≥ 31536000 (1 year)`, value: val };
      return { status: 'fail', detail: 'HSTS present but max-age is 0 or invalid', value: val };
    }
  },
  'content-security-policy': {
    name: 'Content-Security-Policy (CSP)',
    category: 'xss',
    weight: 20,
    check: (val) => {
      if (!val) return { status: 'fail', detail: 'Missing — no XSS protection from content injection', fix: 'Add a CSP header restricting script sources. Start with: Content-Security-Policy: default-src \'self\'' };
      const hasUnsafeInline = val.includes("'unsafe-inline'");
      const hasUnsafeEval = val.includes("'unsafe-eval'");
      const hasWildcard = val.includes('*') && !val.includes('*.');
      if (hasUnsafeInline && hasUnsafeEval) return { status: 'warn', detail: 'CSP present but uses unsafe-inline AND unsafe-eval — significantly weakened', value: val };
      if (hasUnsafeInline) return { status: 'warn', detail: 'CSP uses unsafe-inline — allows inline script execution', value: val };
      if (hasUnsafeEval) return { status: 'warn', detail: 'CSP uses unsafe-eval — allows dynamic code execution', value: val };
      if (hasWildcard) return { status: 'warn', detail: 'CSP uses wildcard (*) source — overly permissive', value: val };
      return { status: 'pass', detail: 'CSP configured without unsafe directives', value: val };
    }
  },
  'x-frame-options': {
    name: 'X-Frame-Options',
    category: 'clickjacking',
    weight: 15,
    check: (val) => {
      if (!val) return { status: 'fail', detail: 'Missing — site can be embedded in iframes (clickjacking risk)', fix: 'Add: X-Frame-Options: DENY or SAMEORIGIN' };
      const v = val.toUpperCase();
      if (v === 'DENY') return { status: 'pass', detail: 'Framing completely blocked', value: val };
      if (v === 'SAMEORIGIN') return { status: 'pass', detail: 'Only same-origin framing allowed', value: val };
      return { status: 'warn', detail: `Unusual value: ${val}`, value: val };
    }
  },
  'x-content-type-options': {
    name: 'X-Content-Type-Options',
    category: 'mime',
    weight: 10,
    check: (val) => {
      if (!val) return { status: 'fail', detail: 'Missing — browsers may MIME-sniff responses', fix: 'Add: X-Content-Type-Options: nosniff' };
      if (val.toLowerCase() === 'nosniff') return { status: 'pass', detail: 'MIME sniffing disabled', value: val };
      return { status: 'warn', detail: `Unexpected value: ${val}`, value: val };
    }
  },
  'referrer-policy': {
    name: 'Referrer-Policy',
    category: 'privacy',
    weight: 10,
    check: (val) => {
      if (!val) return { status: 'warn', detail: 'Missing — full referrer URLs may leak to third parties', fix: 'Add: Referrer-Policy: strict-origin-when-cross-origin' };
      const safe = ['no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'];
      if (safe.includes(val.toLowerCase())) return { status: 'pass', detail: `Referrer policy set to ${val}`, value: val };
      if (val.toLowerCase() === 'unsafe-url') return { status: 'fail', detail: 'unsafe-url leaks full referrer including path and query string', value: val };
      return { status: 'warn', detail: `Policy set to ${val} — review if intentional`, value: val };
    }
  },
  'permissions-policy': {
    name: 'Permissions-Policy',
    category: 'privacy',
    weight: 10,
    check: (val) => {
      if (!val) return { status: 'warn', detail: 'Missing — browser features (camera, mic, geolocation) not restricted', fix: 'Add: Permissions-Policy: camera=(), microphone=(), geolocation=()' };
      return { status: 'pass', detail: 'Browser feature permissions restricted', value: val };
    }
  },
  'cross-origin-opener-policy': {
    name: 'Cross-Origin-Opener-Policy',
    category: 'isolation',
    weight: 5,
    check: (val) => {
      if (!val) return { status: 'info', detail: 'Not set — cross-origin windows can reference this page', fix: 'Consider: Cross-Origin-Opener-Policy: same-origin' };
      return { status: 'pass', detail: `Set to ${val}`, value: val };
    }
  },
  'cross-origin-resource-policy': {
    name: 'Cross-Origin-Resource-Policy',
    category: 'isolation',
    weight: 5,
    check: (val) => {
      if (!val) return { status: 'info', detail: 'Not set — resources may be loaded cross-origin', fix: 'Consider: Cross-Origin-Resource-Policy: same-origin' };
      return { status: 'pass', detail: `Set to ${val}`, value: val };
    }
  },
};

// Headers that leak server info (informational disclosure)
const LEAK_HEADERS = ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-runtime', 'x-version'];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();

  if (!domain || !domain.includes('.')) {
    return new Response(JSON.stringify({ error: 'Invalid domain' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Normalize to https URL
  const targetUrl = domain.startsWith('http') ? domain : `https://${domain}`;

  let headers = {};
  let statusCode = 0;
  let errorMsg = null;

  try {
    const res = await fetch(targetUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'EdgeIQ-Security-Scanner/1.0' },
      cf: { timeout: 8000 },
    });
    statusCode = res.status;
    res.headers.forEach((val, key) => {
      headers[key.toLowerCase()] = val;
    });
  } catch (e) {
    // Retry with GET if HEAD fails
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'EdgeIQ-Security-Scanner/1.0' },
        cf: { timeout: 8000 },
      });
      statusCode = res.status;
      res.headers.forEach((val, key) => {
        headers[key.toLowerCase()] = val;
      });
    } catch (e2) {
      errorMsg = `Could not reach ${domain}: ${e2.message}`;
    }
  }

  if (errorMsg) {
    return new Response(JSON.stringify({ error: errorMsg, domain }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Analyze each security header
  const results = [];
  let score = 0;
  let maxScore = 0;

  Object.entries(SECURITY_HEADERS).forEach(([key, config]) => {
    const value = headers[key] || null;
    const finding = config.check(value);
    results.push({
      header: key,
      name: config.name,
      category: config.category,
      status: finding.status,
      detail: finding.detail,
      value: finding.value || null,
      fix: finding.fix || null,
      weight: config.weight,
    });
    maxScore += config.weight;
    if (finding.status === 'pass') score += config.weight;
    else if (finding.status === 'warn') score += Math.round(config.weight * 0.5);
    else if (finding.status === 'info') score += Math.round(config.weight * 0.7);
  });

  // Check for information leakage
  const leaks = [];
  LEAK_HEADERS.forEach(h => {
    if (headers[h]) {
      leaks.push({ header: h, value: headers[h], detail: `Server information exposed via ${h} header` });
    }
  });

  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const grade = pct >= 90 ? 'A' : pct >= 75 ? 'B' : pct >= 55 ? 'C' : pct >= 35 ? 'D' : 'F';

  return new Response(JSON.stringify({
    domain,
    url: targetUrl,
    statusCode,
    grade,
    score: pct,
    headers: results,
    leaks,
    totalChecked: Object.keys(SECURITY_HEADERS).length,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    warnings: results.filter(r => r.status === 'warn').length,
    checkedAt: new Date().toISOString(),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
