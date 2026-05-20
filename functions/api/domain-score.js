/**
 * EdgeIQ — Domain Security Score
 * GET /api/domain-score?domain=example.com
 *
 * Runs 5 security checks in parallel and returns a unified score (0-100)
 * with an A-F grade, per-category breakdown, and top issues.
 *
 * Scoring:
 *   DMARC   — max 30 pts  (p=reject=30, p=quarantine=18, p=none=6, none=0)
 *   SPF     — max 20 pts  (-all=20, ~all=14, no-all/+all=5, none=0)
 *   DKIM    — max 15 pts  (found=15, none=0)
 *   SSL     — max 30 pts  (https=12, redirect=6, hsts=6, x-frame=3, xcto=3)
 *   MX      — max  5 pts  (found=5, none=0)
 *   Total   — max 100 pts
 *
 *   A ≥ 90 · B ≥ 75 · C ≥ 55 · D ≥ 35 · F < 35
 */

const DOH = 'https://cloudflare-dns.com/dns-query';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── DNS helpers ─────────────────────────────────────────────────────────────

async function dnsQuery(name, type) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

function parseTxt(raw) {
  return (raw || '').replace(/^"|"$/g, '').replace(/" "/g, '');
}

function getTxtValues(resp) {
  return (resp.Answer || []).filter(a => a.type === 16).map(a => parseTxt(a.data || ''));
}

async function fetchHead(url, ms = 7000) {
  try {
    return await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(ms) });
  } catch { return null; }
}

// ─── Individual checks ───────────────────────────────────────────────────────

async function checkDmarc(domain) {
  const resp = await dnsQuery(`_dmarc.${domain}`, 'TXT');
  const records = getTxtValues(resp).filter(v => v.startsWith('v=DMARC1'));

  if (!records.length) {
    return {
      score: 0, max: 30, status: 'fail',
      label: 'DMARC',
      headline: 'No DMARC record found',
      detail: 'Your domain has no DMARC policy. Attackers can send phishing emails that appear to come from your domain.',
      fix: 'Add a DMARC TXT record to your DNS. Start with p=none to collect reports, then move to p=quarantine and finally p=reject.',
      learn: '/inbox-shield/',
    };
  }

  const record = records[0];
  const pMatch = record.match(/\bp=(\w+)/i);
  const policy = pMatch ? pMatch[1].toLowerCase() : 'none';

  if (policy === 'reject') {
    return {
      score: 30, max: 30, status: 'pass',
      label: 'DMARC',
      headline: 'DMARC enforced (p=reject)',
      detail: 'Your DMARC policy is set to p=reject. Unauthenticated email claiming to be from your domain will be rejected.',
      fix: null,
      learn: '/inbox-shield/',
    };
  }

  if (policy === 'quarantine') {
    return {
      score: 18, max: 30, status: 'warn',
      label: 'DMARC',
      headline: 'DMARC set to p=quarantine',
      detail: 'Unauthenticated email from your domain goes to spam — but isn\'t blocked. Upgrading to p=reject closes the gap.',
      fix: 'Update your DMARC record to p=reject once you\'ve confirmed all legitimate senders are passing DMARC alignment.',
      learn: '/inbox-shield/',
    };
  }

  return {
    score: 6, max: 30, status: 'warn',
    label: 'DMARC',
    headline: 'DMARC record found but not enforced (p=none)',
    detail: 'You have a DMARC record but it\'s set to p=none — monitoring only. Spoofed emails still get delivered to inboxes.',
    fix: 'Move through p=quarantine to p=reject to actually block spoofed email. Use the rua= tag to collect alignment reports first.',
    learn: '/inbox-shield/',
  };
}

async function checkSpf(domain) {
  const resp = await dnsQuery(domain, 'TXT');
  const spfRecords = getTxtValues(resp).filter(v => v.startsWith('v=spf1'));

  if (!spfRecords.length) {
    return {
      score: 0, max: 20, status: 'fail',
      label: 'SPF',
      headline: 'No SPF record found',
      detail: 'Your domain has no SPF record. Anyone can send email that claims to be from your domain.',
      fix: 'Add a TXT record: v=spf1 include:[your mail provider] -all. Replace [your mail provider] with your ESP\'s include directive.',
      learn: '/inbox-shield/',
    };
  }

  const record = spfRecords[0];
  if (record.includes('-all')) {
    return {
      score: 20, max: 20, status: 'pass',
      label: 'SPF',
      headline: 'SPF configured with hard fail (-all)',
      detail: 'Your SPF record uses -all, which tells receiving servers to reject any sender not explicitly listed.',
      fix: null,
      learn: '/inbox-shield/',
    };
  }

  if (record.includes('~all')) {
    return {
      score: 14, max: 20, status: 'warn',
      label: 'SPF',
      headline: 'SPF configured with soft fail (~all)',
      detail: 'Your SPF record uses ~all (soft fail). Unauthorized senders are marked but not rejected. Consider upgrading to -all.',
      fix: 'Change ~all to -all in your SPF record once you\'ve confirmed all legitimate senders are included.',
      learn: '/inbox-shield/',
    };
  }

  if (record.includes('+all')) {
    return {
      score: 2, max: 20, status: 'fail',
      label: 'SPF',
      headline: 'SPF uses +all — allows any sender',
      detail: 'Your SPF record uses +all, which authorizes any server to send email on your behalf. This effectively defeats SPF.',
      fix: 'Replace +all with -all and explicitly list your authorized senders.',
      learn: '/inbox-shield/',
    };
  }

  return {
    score: 10, max: 20, status: 'warn',
    label: 'SPF',
    headline: 'SPF record found but has no "all" qualifier',
    detail: 'Your SPF record doesn\'t include a catch-all (-all or ~all) mechanism. Add one to define what to do with unauthorized senders.',
    fix: 'Add -all to the end of your SPF record.',
    learn: '/inbox-shield/',
  };
}

async function checkDkim(domain) {
  // Probe common DKIM selectors
  const selectors = ['google', 'selector1', 'selector2', 'default', 'mail', 'k1', 'dkim', 's1', 's2'];
  const probes = await Promise.all(
    selectors.map(sel => dnsQuery(`${sel}._domainkey.${domain}`, 'TXT'))
  );

  for (let i = 0; i < selectors.length; i++) {
    const vals = getTxtValues(probes[i]);
    if (vals.some(v => v.includes('v=DKIM1') || v.includes('p='))) {
      return {
        score: 15, max: 15, status: 'pass',
        label: 'DKIM',
        headline: `DKIM key found (selector: ${selectors[i]})`,
        detail: 'A DKIM public key was found. Emails signed with the matching private key will pass DKIM verification.',
        fix: null,
        learn: '/inbox-shield/',
      };
    }
  }

  return {
    score: 0, max: 15, status: 'fail',
    label: 'DKIM',
    headline: 'No DKIM key found',
    detail: 'No DKIM public key was found for common selectors. Without DKIM, emails can\'t be cryptographically verified as authentic.',
    fix: 'Enable DKIM signing in your email provider (Google Workspace, Microsoft 365, or your ESP) and publish the public key to DNS.',
    learn: '/inbox-shield/',
  };
}

async function checkMx(domain) {
  const resp = await dnsQuery(domain, 'MX');
  const hasMx = (resp.Answer || []).some(a => a.type === 15);

  return hasMx
    ? {
        score: 5, max: 5, status: 'pass',
        label: 'Mail Server',
        headline: 'MX records found',
        detail: 'Your domain has MX records configured, meaning it can receive email.',
        fix: null, learn: '/inbox-shield/',
      }
    : {
        score: 0, max: 5, status: 'warn',
        label: 'Mail Server',
        headline: 'No MX records found',
        detail: 'Your domain has no MX records — it cannot receive email. This may be intentional for send-only domains.',
        fix: 'If your domain receives email, add MX records pointing to your mail provider.',
        learn: '/inbox-shield/',
      };
}

async function checkSsl(domain) {
  const [httpsResp, httpResp] = await Promise.all([
    fetchHead(`https://${domain}/`),
    fetchHead(`http://${domain}/`),
  ]);

  let score = 0;
  const checks = [];

  // HTTPS accessible: 12pts
  const httpsOk = !!httpsResp && httpsResp.status < 600;
  if (httpsOk) {
    score += 12;
    checks.push({ label: 'HTTPS accessible', pass: true });
  } else {
    checks.push({ label: 'HTTPS accessible', pass: false });
    return {
      score, max: 30, status: 'fail',
      label: 'SSL / HTTPS',
      headline: 'HTTPS not accessible',
      detail: 'Your site is not reachable over HTTPS. This exposes all traffic to interception and breaks trust signals.',
      fix: 'Enable HTTPS on your web server. Most providers offer free SSL via Let\'s Encrypt.',
      learn: '/pulse/',
    };
  }

  const headers = httpsResp.headers;

  // HTTP → HTTPS redirect: 6pts
  const httpOk = !!httpResp;
  const redirectsToHttps = httpOk && [301, 302, 307, 308].includes(httpResp.status)
    && (httpResp.headers.get('location') || '').startsWith('https://');
  if (redirectsToHttps) { score += 6; checks.push({ label: 'HTTP redirects to HTTPS', pass: true }); }
  else { checks.push({ label: 'HTTP redirects to HTTPS', pass: false }); }

  // HSTS: 6pts
  const hsts = headers.get('strict-transport-security') || '';
  if (hsts) { score += 6; checks.push({ label: 'HSTS header', pass: true }); }
  else { checks.push({ label: 'HSTS header', pass: false }); }

  // X-Frame-Options: 3pts
  const xfo = headers.get('x-frame-options');
  if (xfo) { score += 3; checks.push({ label: 'X-Frame-Options', pass: true }); }
  else { checks.push({ label: 'X-Frame-Options', pass: false }); }

  // X-Content-Type-Options: 3pts
  const xcto = headers.get('x-content-type-options');
  if (xcto) { score += 3; checks.push({ label: 'X-Content-Type-Options', pass: true }); }
  else { checks.push({ label: 'X-Content-Type-Options', pass: false }); }

  const status = score >= 24 ? 'pass' : score >= 14 ? 'warn' : 'fail';
  const passCount = checks.filter(c => c.pass).length;

  const fixes = [];
  if (!redirectsToHttps) fixes.push('Redirect all HTTP traffic to HTTPS with a 301 redirect.');
  if (!hsts) fixes.push('Add a Strict-Transport-Security header (e.g. max-age=31536000; includeSubDomains).');
  if (!xfo) fixes.push('Add an X-Frame-Options: SAMEORIGIN header to prevent clickjacking.');
  if (!xcto) fixes.push('Add an X-Content-Type-Options: nosniff header.');

  return {
    score, max: 30, status,
    label: 'SSL / HTTPS',
    headline: status === 'pass'
      ? `SSL/HTTPS well-configured (${passCount}/5 checks passed)`
      : `SSL/HTTPS has gaps (${passCount}/5 checks passed)`,
    detail: status === 'pass'
      ? 'Your HTTPS configuration is solid — encrypted, redirecting, and with security headers set.'
      : `Your site uses HTTPS but is missing some hardening. ${fixes.length} issue${fixes.length > 1 ? 's' : ''} found.`,
    fix: fixes.length ? fixes.join(' ') : null,
    learn: '/pulse/',
  };
}

// ─── Main handler ────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return Response.json(data, { status, headers: { ...CORS, 'Cache-Control': 'public, max-age=180' } });
}

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!domain || !domain.includes('.') || domain.length < 4) {
    return json({ error: 'Please provide a valid domain (e.g. example.com)' }, 400);
  }

  const [dmarc, spf, dkim, ssl, mx] = await Promise.all([
    checkDmarc(domain),
    checkSpf(domain),
    checkDkim(domain),
    checkSsl(domain),
    checkMx(domain),
  ]);

  const totalScore = dmarc.score + spf.score + dkim.score + ssl.score + mx.score;
  const grade = totalScore >= 90 ? 'A' : totalScore >= 75 ? 'B' : totalScore >= 55 ? 'C' : totalScore >= 35 ? 'D' : 'F';

  // Summary message
  const summaries = {
    A: 'Excellent — your domain\'s security posture is strong across all key areas.',
    B: 'Good — your domain is mostly well-configured with a few gaps worth closing.',
    C: 'Fair — there are meaningful security gaps that could expose you or your customers.',
    D: 'Poor — your domain has significant security vulnerabilities that need attention.',
    F: 'Critical — your domain has serious security gaps that attackers can exploit right now.',
  };

  // Top issues (shown after email gate)
  const issues = [dmarc, spf, dkim, ssl, mx]
    .filter(c => c.status !== 'pass' && c.fix)
    .map(c => ({ category: c.label, headline: c.headline, fix: c.fix, learn: c.learn }));

  // Product recommendations based on failures
  const recs = [];
  const emailFailing = dmarc.status !== 'pass' || spf.status !== 'pass' || dkim.status !== 'pass';
  const sslFailing = ssl.status !== 'pass';
  if (emailFailing) recs.push({ name: 'Inbox Shield', desc: 'Monitor DMARC, SPF, and DKIM continuously', href: '/inbox-shield/', color: '#b47aff' });
  if (sslFailing) recs.push({ name: 'Pulse', desc: 'SSL certificate + attack surface monitoring', href: '/pulse/', color: '#3dd9ff' });

  return json({
    domain,
    score: totalScore,
    max: 100,
    grade,
    summary: summaries[grade],
    categories: [
      { ...dmarc },
      { ...spf },
      { ...dkim },
      { ...ssl },
      { ...mx },
    ],
    issues,
    recommendations: recs,
  });
}
