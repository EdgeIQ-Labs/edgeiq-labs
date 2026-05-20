/**
 * EdgeIQ — Subdomain Scanner
 * GET /api/subdomain-scan?domain=example.com
 *
 * Enumerates subdomains via certificate transparency logs (crt.sh)
 * and common DNS record types. Returns first 10 free; full list
 * is gated behind Pulse signup.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DOH = 'https://cloudflare-dns.com/dns-query';

// Common subdomains to probe via DNS
const COMMON_SUBS = [
  'www', 'mail', 'smtp', 'pop', 'imap', 'webmail', 'mx', 'mx1', 'mx2',
  'ftp', 'sftp', 'ssh', 'vpn', 'remote', 'citrix', 'rdp',
  'dev', 'staging', 'stage', 'test', 'uat', 'qa', 'beta', 'demo', 'preview',
  'api', 'api2', 'v1', 'v2', 'rest', 'graphql', 'ws',
  'admin', 'portal', 'app', 'apps', 'dashboard', 'panel', 'manage',
  'cdn', 'static', 'assets', 'media', 'img', 'images', 'uploads',
  'status', 'health', 'monitor', 'metrics', 'logs',
  'blog', 'docs', 'help', 'support', 'wiki', 'kb',
  'shop', 'store', 'checkout', 'pay', 'payment',
  'git', 'gitlab', 'jenkins', 'ci', 'build', 'deploy',
  's3', 'backup', 'db', 'database', 'mysql', 'mongo', 'redis',
  'ns1', 'ns2', 'ns3', 'dns', 'resolver',
  'intranet', 'internal', 'corp', 'office',
];

async function dnsProbe(subdomain) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(subdomain)}&type=A`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const aRecs = (data.Answer || []).filter(a => a.type === 1);
    if (!aRecs.length) return null;
    return aRecs[0].data; // return IP
  } catch { return null; }
}

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!domain || !domain.includes('.') || domain.length < 4) {
    return Response.json({ error: 'Invalid domain' }, { status: 400, headers: CORS });
  }

  // 1. Fetch from crt.sh (certificate transparency logs)
  let ctSubdomains = [];
  try {
    const ctResp = await fetch(
      `https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`,
      { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } }
    );
    if (ctResp.ok) {
      const ctData = await ctResp.json();
      const seen = new Set();
      for (const entry of ctData) {
        const names = (entry.name_value || '').split('\n');
        for (const n of names) {
          const sub = n.trim().toLowerCase().replace(/^\*\./, '');
          if (sub.endsWith(`.${domain}`) || sub === domain) {
            const label = sub === domain ? sub : sub.slice(0, sub.length - domain.length - 1);
            if (label && !seen.has(sub)) {
              seen.add(sub);
              ctSubdomains.push({ name: sub, source: 'ct' });
            }
          }
        }
      }
    }
  } catch (_) {}

  // 2. DNS probe common names (batched, max 30 probes to stay fast)
  const probeTargets = COMMON_SUBS.slice(0, 30).map(s => `${s}.${domain}`);
  const ctNames = new Set(ctSubdomains.map(s => s.name));

  const probeResults = await Promise.all(
    probeTargets.map(async fqdn => {
      if (ctNames.has(fqdn)) return null; // already found via CT
      const ip = await dnsProbe(fqdn);
      return ip ? { name: fqdn, ip, source: 'dns' } : null;
    })
  );
  const dnsSubdomains = probeResults.filter(Boolean);

  // Merge and sort
  const all = [...ctSubdomains, ...dnsSubdomains];
  // Deduplicate
  const dedupMap = new Map();
  for (const s of all) {
    if (!dedupMap.has(s.name)) dedupMap.set(s.name, s);
  }
  const merged = Array.from(dedupMap.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  const total     = merged.length;
  const preview   = merged.slice(0, 10);  // First 10 free
  const remaining = Math.max(0, total - 10);

  return Response.json({
    domain,
    total,
    subdomains:       preview,
    remaining_count:  remaining,
    gated:            remaining > 0,
    sources: {
      certificate_transparency: ctSubdomains.length,
      dns_probe: dnsSubdomains.length,
    },
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=600' } });
}
