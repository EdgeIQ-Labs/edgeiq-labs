/**
 * EdgeIQ — Email Blacklist / DNSBL Checker
 * GET /api/blacklist-check?domain=example.com
 * GET /api/blacklist-check?ip=1.2.3.4
 *
 * Checks a domain or IP against 7 major IP-based DNSBLs.
 *
 * IP-based lookup: reverse(ip).dnsbl → A query → listed if any 127.x.x.x answer
 * Domain-based lookup: domain.dnsbl → A query → listed if any answer
 *
 * Returns per-list status, listing count, risk level, and removal links.
 */

const DOH = 'https://cloudflare-dns.com/dns-query';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── DNSBL Definitions ───────────────────────────────────────────────────────

// Excluded lists (all produce false positives via public DoH resolvers):
//  - Spamhaus sbl/xbl/pbl/dbl/hbl/zen: without DQS key → 127.0.0.2 for ALL queries
//  - SURBL multi.surbl.org: returns SERVFAIL ("No Reachable Authority") via Cloudflare DoH
//  - URIBL multi.uribl.com: lists domains found in spam *URLs* (e.g. google.com) —
//    not sending IP reputation. Returns false positives for major legitimate domains.
// Remaining 7 IP-based lists check actual sending reputation reliably.

const IP_LISTS = [
  { id: 'barracuda',     name: 'Barracuda BRBL',    zone: 'b.barracudacentral.org',  tier: 'critical', removal: 'https://www.barracudacentral.org/lookups' },
  { id: 'sorbs-spam',    name: 'SORBS SPAM',        zone: 'spam.sorbs.net',          tier: 'high',     removal: 'http://www.sorbs.net/lookup.shtml' },
  { id: 'spamcop',       name: 'SpamCop BL',        zone: 'bl.spamcop.net',          tier: 'critical', removal: 'https://www.spamcop.net/bl.shtml' },
  { id: 'uceprotect-1',  name: 'UCEPROTECT L1',     zone: 'dnsbl-1.uceprotect.net',  tier: 'high',     removal: 'http://www.uceprotect.net/en/rblcheck.php' },
  { id: 'mailspike',     name: 'Mailspike BL',      zone: 'bl.mailspike.net',        tier: 'high',     removal: 'https://www.mailspike.net/lookup/' },
  { id: 'nordspam',      name: 'NordSpam BL',       zone: 'bl.nordspam.com',         tier: 'medium',   removal: 'https://www.nordspam.com/' },
  { id: 'truncate',      name: 'Truncate (GBudb)',  zone: 'truncate.gbudb.net',      tier: 'medium',   removal: 'https://gbudb.net/truncate/index.jsp' },
];

// No domain-based lists: SURBL/URIBL both produce false positives via
// public DoH resolvers. All 7 remaining checks are IP-based (sending reputation).
const DOMAIN_LISTS = [];

// ─── DNS helpers ─────────────────────────────────────────────────────────────

async function dnsQuery(name, type) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

function reverseIp(ip) {
  return ip.split('.').reverse().join('.');
}

function isValidIpv4(str) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str) &&
    str.split('.').every(n => parseInt(n, 10) <= 255);
}

async function resolveToIp(domain) {
  const resp = await dnsQuery(domain, 'A');
  const aRecords = (resp.Answer || []).filter(a => a.type === 1);
  return aRecords.length ? aRecords[0].data : null;
}

async function checkIpList(ip, list) {
  const query = `${reverseIp(ip)}.${list.zone}`;
  const resp = await dnsQuery(query, 'A');
  const answers = (resp.Answer || []).filter(a => a.type === 1);
  const listed = answers.some(a => a.data && a.data.startsWith('127.'));
  return {
    ...list,
    listed,
    returnCode: listed ? (answers[0]?.data || null) : null,
  };
}

async function checkDomainList(domain, list) {
  const query = `${domain}.${list.zone}`;
  const resp = await dnsQuery(query, 'A');
  const answers = (resp.Answer || []).filter(a => a.type === 1);
  // Some domain lists return NXDOMAIN for clean, or an A record for listed
  // Also check that the answer isn't SERVFAIL (rcode 2)
  const listed = answers.length > 0 && answers.some(a => a.data && a.data.startsWith('127.'));
  return {
    ...list,
    listed,
    returnCode: listed ? (answers[0]?.data || null) : null,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let rawInput = (url.searchParams.get('domain') || url.searchParams.get('ip') || '').trim().toLowerCase();
  rawInput = rawInput.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!rawInput || rawInput.length < 4) {
    return Response.json({ error: 'Please provide a domain or IP address' }, { status: 400, headers: CORS });
  }

  // Determine if input is IP or domain
  const inputIsIp = isValidIpv4(rawInput);
  let ip = null;
  let domain = null;

  if (inputIsIp) {
    ip = rawInput;
    domain = null; // no domain to check domain lists
  } else {
    domain = rawInput;
    if (!domain.includes('.')) {
      return Response.json({ error: 'Please provide a valid domain or IP' }, { status: 400, headers: CORS });
    }
    // Resolve domain to IP
    ip = await resolveToIp(domain);
  }

  // Run all checks in parallel
  const ipChecks = ip
    ? IP_LISTS.map(list => checkIpList(ip, list))
    : IP_LISTS.map(list => Promise.resolve({ ...list, listed: false, returnCode: null, skipped: true }));

  const domainChecks = domain
    ? DOMAIN_LISTS.map(list => checkDomainList(domain, list))
    : DOMAIN_LISTS.map(list => Promise.resolve({ ...list, listed: false, returnCode: null, skipped: true }));

  const [ipResults, domainResults] = await Promise.all([
    Promise.all(ipChecks),
    Promise.all(domainChecks),
  ]);

  const allResults = [...ipResults, ...domainResults].filter(r => !r.skipped);
  const listedCount = allResults.filter(r => r.listed).length;
  const checkedCount = allResults.length;

  // Risk level
  const criticalListings = allResults.filter(r => r.listed && r.tier === 'critical').length;
  const risk = criticalListings > 0
    ? 'critical'
    : listedCount >= 3
      ? 'high'
      : listedCount >= 1
        ? 'medium'
        : 'clean';

  const riskMessages = {
    clean:    'Your domain/IP is not listed on any of the checked blacklists.',
    medium:   'Listed on at least one blacklist. Some email providers may reject or filter your messages.',
    high:     'Listed on multiple blacklists. Email deliverability is likely affected.',
    critical: 'Listed on a major blacklist (Barracuda/SpamCop). Email deliverability will be severely impacted.',
  };

  // Categorise results for display
  const listed = allResults.filter(r => r.listed).map(r => ({
    name: r.name, tier: r.tier, removal: r.removal, returnCode: r.returnCode,
  }));
  const clean = allResults.filter(r => !r.listed).map(r => ({ name: r.name, tier: r.tier }));

  return Response.json({
    input: rawInput,
    inputType: inputIsIp ? 'ip' : 'domain',
    resolvedIp: ip,
    domain: domain,
    checked: checkedCount,
    listedCount,
    cleanCount: checkedCount - listedCount,
    risk,
    riskMessage: riskMessages[risk],
    listed,
    clean,
    ipListsChecked: ip ? ipResults.filter(r => !r.skipped).length : 0,
    domainListsChecked: domain ? domainResults.filter(r => !r.skipped).length : 0,
  }, {
    status: 200,
    headers: { ...CORS, 'Cache-Control': 'public, max-age=120' },
  });
}
