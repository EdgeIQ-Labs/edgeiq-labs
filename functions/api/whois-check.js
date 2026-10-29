/**
 * EdgeIQ — WHOIS Lookup
 * GET /api/whois-check?domain=example.com
 *
 * Queries RDAP (Registration Data Access Protocol) for domain registration info.
 * RDAP is the modern replacement for WHOIS, returns structured JSON natively.
 */

// Bootstrap RDAP servers by TLD
const RDAP_SERVERS = {
  com: 'https://rdap.verisign.com/com/v1/domain/',
  net: 'https://rdap.verisign.com/net/v1/domain/',
  org: 'https://rdap.org/domain/',
  io: 'https://rdap.nic.io/domain/',
  co: 'https://rdap.nic.co/domain/',
  dev: 'https://www.registry.google/rdap/domain/',
  app: 'https://www.registry.google/rdap/domain/',
  xyz: 'https://rdap.centralnic.com/xyz/domain/',
  me: 'https://rdap.identitydigital.services/v1/domain/',
  info: 'https://rdap.afilias.net/rdap/info/domain/',
  us: 'https://rdap.nic.us/domain/',
  uk: 'https://rdap.nic.uk/domain/',
  ca: 'https://rdap.ca.fury.ca/rdap/domain/',
  au: 'https://rdap.auda.org.au/domain/',
  de: 'https://rdap.denic.de/domain/',
  fr: 'https://rdap.nic.fr/domain/',
};

function getTld(domain) {
  const parts = domain.split('.');
  return parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : '';
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return dateStr;
  }
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  try {
    const target = new Date(dateStr);
    const now = new Date();
    const diff = Math.ceil((target - now) / (1000 * 60 * 60 * 24));
    return diff;
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];

  if (!domain || !domain.includes('.')) {
    return new Response(JSON.stringify({ error: 'Invalid domain' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const tld = getTld(domain);
  const rdapBase = RDAP_SERVERS[tld];

  if (!rdapBase) {
    // Fallback: try IANA bootstrap
    try {
      const bootstrapRes = await fetch(`https://data.iana.org/rdap/dns.json`, { cf: { timeout: 5000 } });
      if (bootstrapRes.ok) {
        const bootstrap = await bootstrapRes.json();
        // services is array of [tlds[], urls[]]
        for (const [tlds, urls] of bootstrap.services || []) {
          if (tlds.includes(tld)) {
            const fallbackUrl = urls[0];
            if (fallbackUrl) {
              return await queryRdap(fallbackUrl.endsWith('/') ? fallbackUrl : fallbackUrl + '/', domain, tld);
            }
          }
        }
      }
    } catch {}

    return new Response(JSON.stringify({
      error: `RDAP server not found for .${tld} domains`,
      domain,
      tld,
      suggestion: 'Try a different TLD or check manually at whois.domaintools.com',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  return await queryRdap(rdapBase, domain, tld);
}

async function queryRdap(baseUrl, domain, tld) {
  try {
    const rdapUrl = `${baseUrl}${encodeURIComponent(domain)}`;
    const res = await fetch(rdapUrl, {
      headers: { 'Accept': 'application/rdap+json' },
      cf: { timeout: 8000 },
    });

    if (!res.ok) {
      if (res.status === 404) {
        return new Response(JSON.stringify({
          domain,
          tld,
          registered: false,
          message: 'Domain does not appear to be registered',
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      throw new Error(`RDAP returned ${res.status}`);
    }

    const data = await res.json();

    // Extract events (registration, expiry, update)
    const events = {};
    (data.events || []).forEach(e => {
      if (e.eventAction === 'registration') events.registered = parseDate(e.eventDate);
      if (e.eventAction === 'expiration') events.expires = parseDate(e.eventDate);
      if (e.eventAction === 'last changed') events.updated = parseDate(e.eventDate);
    });

    // Extract nameservers
    const nameservers = (data.nameservers || []).map(ns => ns.ldhName || ns.objectClassName || 'unknown');

    // Extract registrar
    let registrar = null;
    (data.entities || []).forEach(ent => {
      const roles = ent.roles || [];
      if (roles.includes('registrar')) {
        // Try to get the name from vcardArray
        if (ent.vcardArray && ent.vcardArray[1]) {
          const fnEntry = ent.vcardArray[1].find(v => v[0] === 'fn');
          if (fnEntry) registrar = fnEntry[3];
        }
        if (!registrar && ent.handle) registrar = ent.handle;
      }
    });

    // Status
    const statuses = data.status || [];

    const daysToExpiry = daysUntil(events.expires);

    return new Response(JSON.stringify({
      domain,
      tld,
      registered: true,
      registrar,
      dates: events,
      daysToExpiry,
      nameservers,
      statuses,
      rdapUrl: baseUrl + encodeURIComponent(domain),
      checkedAt: new Date().toISOString(),
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: `WHOIS lookup failed: ${e.message}`,
      domain,
      tld,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
