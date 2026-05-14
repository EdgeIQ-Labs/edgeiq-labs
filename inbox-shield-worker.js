/**
 * EdgeIQ Inbox Shield — Email Security Scanner Worker
 * Deploy as: edgeiq-inbox-shield.gpalmieri21.workers.dev
 *
 * Checks SPF, DMARC, DKIM (auto-detect selectors), MX, and BIMI
 * for any domain. Returns structured findings + A-F grade.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const DKIM_SELECTORS = [
  'google', 'google2', 'k1', 'k2', 's1', 's2',
  'default', 'mail', 'email', 'dkim', 'dkim1', 'dkim2',
  'selector1', 'selector2', 'selector3',
  'mandrill', 'mailchimp', 'mc', 'sendgrid', 'sg',
  'amazonses', 'ses', 'postmaster', 'pm',
  'mimecast', 'proofpoint', 'mx',
  'resend', 'r1', 'r2', 'brevo', 'sparkpost', 'mailgun',
];

async function dnsQuery(name, type) {
  try {
    const resp = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.Answer || []).map(r => r.data.replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  } catch {
    return [];
  }
}

async function checkSPF(domain) {
  const records = await dnsQuery(domain, 'TXT');
  const spf = records.find(r => r.startsWith('v=spf1'));
  if (!spf) return { present: false, record: null, grade: 'F', findings: [
    { severity: 'high', type: 'SPF_MISSING', message: 'No SPF record found. Anyone can send email pretending to be from ' + domain + '.' }
  ]};

  const findings = [];
  let grade = 'A';

  if (spf.includes('+all')) {
    findings.push({ severity: 'critical', type: 'SPF_PASS_ALL', message: 'SPF uses "+all" — allows any server to send as ' + domain + '. This defeats the purpose of SPF entirely.' });
    grade = 'F';
  } else if (spf.includes('?all')) {
    findings.push({ severity: 'high', type: 'SPF_NEUTRAL_ALL', message: 'SPF uses "?all" (neutral) — provides no protection against spoofing.' });
    grade = 'D';
  } else if (spf.includes('~all')) {
    findings.push({ severity: 'low', type: 'SPF_SOFTFAIL', message: 'SPF uses "~all" (softfail) — unauthorized senders are flagged but not rejected. Consider upgrading to "-all".' });
    grade = 'B';
  } else if (spf.includes('-all')) {
    findings.push({ severity: 'info', type: 'SPF_HARDFAIL', message: 'SPF uses "-all" (hardfail) — unauthorized senders are rejected. Best practice.' });
  } else {
    findings.push({ severity: 'medium', type: 'SPF_NO_ALL', message: 'SPF record has no "all" mechanism. Behavior is undefined for unauthorized senders.' });
    grade = 'C';
  }

  // Check for too many DNS lookups (RFC 7208 limit is 10)
  const lookupTerms = (spf.match(/\b(include:|a:|mx:|exists:|redirect=)/g) || []).length;
  if (lookupTerms > 8) {
    findings.push({ severity: 'medium', type: 'SPF_TOO_MANY_LOOKUPS', message: `SPF record has ~${lookupTerms} DNS lookups. RFC 7208 limit is 10 — exceeding it causes delivery failures.` });
  }

  return { present: true, record: spf, grade, findings };
}

async function checkDMARC(domain) {
  const records = await dnsQuery('_dmarc.' + domain, 'TXT');
  const dmarc = records.find(r => r.startsWith('v=DMARC1'));

  if (!dmarc) return { present: false, record: null, grade: 'F', findings: [
    { severity: 'high', type: 'DMARC_MISSING', message: 'No DMARC record found. Without DMARC, you have no visibility into who is sending email as ' + domain + ' and no policy to enforce.' }
  ]};

  const findings = [];
  let grade = 'A';

  // Policy
  const pMatch = dmarc.match(/\bp=(\w+)/);
  const policy = pMatch ? pMatch[1].toLowerCase() : null;
  if (!policy || policy === 'none') {
    findings.push({ severity: 'medium', type: 'DMARC_POLICY_NONE', message: 'DMARC policy is "none" — monitoring only. Spoofed emails are not blocked. Upgrade to p=quarantine or p=reject.' });
    grade = 'C';
  } else if (policy === 'quarantine') {
    findings.push({ severity: 'low', type: 'DMARC_POLICY_QUARANTINE', message: 'DMARC policy is "quarantine" — failing emails go to spam. Good. Consider upgrading to p=reject for full protection.' });
    grade = 'B';
  } else if (policy === 'reject') {
    findings.push({ severity: 'info', type: 'DMARC_POLICY_REJECT', message: 'DMARC policy is "reject" — spoofed emails are blocked outright. Best practice.' });
  }

  // Subdomain policy
  const spMatch = dmarc.match(/\bsp=(\w+)/);
  if (!spMatch) {
    findings.push({ severity: 'low', type: 'DMARC_NO_SUBDOMAIN_POLICY', message: 'No subdomain policy (sp=) set. Subdomains inherit the root policy — consider setting sp=reject explicitly.' });
  }

  // Reporting
  if (!dmarc.includes('rua=')) {
    findings.push({ severity: 'low', type: 'DMARC_NO_REPORTING', message: 'No aggregate reporting address (rua=). You have no visibility into who is sending as your domain.' });
    if (grade === 'A') grade = 'B';
  }

  // pct
  const pctMatch = dmarc.match(/\bpct=(\d+)/);
  if (pctMatch && parseInt(pctMatch[1]) < 100) {
    findings.push({ severity: 'low', type: 'DMARC_PCT_LOW', message: `DMARC applies to only ${pctMatch[1]}% of failing email (pct=${pctMatch[1]}). Set pct=100 for full enforcement.` });
  }

  return { present: true, record: dmarc, policy, grade, findings };
}

async function checkDKIM(domain) {
  // Try common selectors concurrently in batches
  const batch1 = DKIM_SELECTORS.slice(0, 12);
  const batch2 = DKIM_SELECTORS.slice(12);

  const trySelectors = async (selectors) => {
    const checks = selectors.map(async (sel) => {
      const records = await dnsQuery(`${sel}._domainkey.${domain}`, 'TXT');
      const dkim = records.find(r => r.includes('v=DKIM1') || r.includes('k=rsa') || r.includes('p='));
      return dkim ? { selector: sel, record: dkim } : null;
    });
    return (await Promise.all(checks)).filter(Boolean);
  };

  const found1 = await trySelectors(batch1);
  const found2 = found1.length ? [] : await trySelectors(batch2);
  const found = [...found1, ...found2];

  const findings = [];
  let grade = 'A';

  if (!found.length) {
    findings.push({ severity: 'high', type: 'DKIM_NOT_FOUND', message: 'No DKIM record detected on common selectors. Without DKIM, email authenticity cannot be cryptographically verified.' });
    grade = 'D';
  } else {
    found.forEach(f => {
      findings.push({ severity: 'info', type: 'DKIM_FOUND_' + f.selector.toUpperCase(), message: `DKIM key found: selector "${f.selector}". Cryptographic signing is active.` });
      // Check for weak key (short p= value suggests RSA-512 or RSA-768)
      const pMatch = f.record.match(/p=([A-Za-z0-9+/=]+)/);
      if (pMatch && pMatch[1].length < 88) {
        findings.push({ severity: 'medium', type: 'DKIM_WEAK_KEY_' + f.selector.toUpperCase(), message: `DKIM key for selector "${f.selector}" appears short — may be RSA-512/768. Upgrade to RSA-2048 minimum.` });
        grade = 'B';
      }
    });
  }

  return { present: found.length > 0, selectors: found.map(f => f.selector), grade, findings };
}

async function checkMX(domain) {
  const records = await dnsQuery(domain, 'MX');
  const findings = [];

  if (!records.length) {
    findings.push({ severity: 'medium', type: 'MX_MISSING', message: 'No MX records found. This domain cannot receive email.' });
    return { present: false, records: [], grade: 'F', findings };
  }

  findings.push({ severity: 'info', type: 'MX_PRESENT', message: `${records.length} MX record${records.length > 1 ? 's' : ''} found: ${records.slice(0,3).join(', ')}` });
  return { present: true, records, grade: 'A', findings };
}

async function checkBIMI(domain) {
  const records = await dnsQuery('default._bimi.' + domain, 'TXT');
  const bimi = records.find(r => r.startsWith('v=BIMI1'));
  if (bimi) {
    return { present: true, record: bimi, findings: [
      { severity: 'info', type: 'BIMI_PRESENT', message: 'BIMI record found. Your brand logo may appear in supporting email clients (Gmail, Yahoo, Apple Mail).' }
    ]};
  }
  return { present: false, findings: [
    { severity: 'info', type: 'BIMI_MISSING', message: 'No BIMI record. BIMI displays your logo in inboxes — requires p=quarantine or p=reject DMARC first.' }
  ]};
}

function overallGrade(spf, dmarc, dkim) {
  const gradeVal = { 'A': 4, 'B': 3, 'C': 2, 'D': 1, 'F': 0 };
  const gradeStr = ['F', 'D', 'C', 'B', 'A'];
  // Weighted: DMARC 40%, SPF 35%, DKIM 25%
  const score = (gradeVal[dmarc.grade] * 40 + gradeVal[spf.grade] * 35 + gradeVal[dkim.grade] * 25) / 100;
  return gradeStr[Math.round(score)];
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: CORS });

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS });
    }

    const domain = (body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
    if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9\-\.]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(domain)) {
      return new Response(JSON.stringify({ error: 'Invalid domain' }), { status: 400, headers: CORS });
    }

    const [spf, dmarc, dkim, mx, bimi] = await Promise.all([
      checkSPF(domain),
      checkDMARC(domain),
      checkDKIM(domain),
      checkMX(domain),
      checkBIMI(domain),
    ]);

    const grade = overallGrade(spf, dmarc, dkim);
    const allFindings = [
      ...spf.findings,
      ...dmarc.findings,
      ...dkim.findings,
      ...mx.findings,
      ...bimi.findings,
    ];

    const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
    const highCount     = allFindings.filter(f => f.severity === 'high').length;
    const mediumCount   = allFindings.filter(f => f.severity === 'medium').length;

    return new Response(JSON.stringify({
      domain,
      grade,
      timestamp: new Date().toISOString(),
      summary: `Email security grade: ${grade}. ${criticalCount > 0 ? criticalCount + ' critical, ' : ''}${highCount > 0 ? highCount + ' high, ' : ''}${mediumCount} medium issues found.`,
      checks: {
        spf:   { present: spf.present,   grade: spf.grade,   record: spf.record   },
        dmarc: { present: dmarc.present,  grade: dmarc.grade, record: dmarc.record, policy: dmarc.policy },
        dkim:  { present: dkim.present,   grade: dkim.grade,  selectors: dkim.selectors },
        mx:    { present: mx.present,     grade: mx.grade,    records: mx.records  },
        bimi:  { present: bimi.present },
      },
      findings: allFindings,
    }), { status: 200, headers: CORS });
  },
};
