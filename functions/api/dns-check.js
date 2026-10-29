/**
 * EdgeIQ — DNS Record Checker
 * GET /api/dns-check?domain=example.com&type=A
 *
 * Queries Cloudflare DoH for all common record types.
 * Returns structured JSON with TTL, priority, etc.
 */

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'PTR'];

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const domain = (url.searchParams.get('domain') || '').trim().toLowerCase();

  if (!domain || !domain.includes('.')) {
    return new Response(JSON.stringify({ error: 'Invalid domain' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Optional: filter to specific type
  const requestedType = (url.searchParams.get('type') || '').toUpperCase();
  const types = requestedType && RECORD_TYPES.includes(requestedType)
    ? [requestedType]
    : RECORD_TYPES;

  const results = {};
  const errors = [];

  await Promise.all(types.map(async (type) => {
    try {
      const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
      const res = await fetch(dohUrl, {
        headers: { 'Accept': 'application/dns-json' },
      });
      if (!res.ok) throw new Error(`DoH returned ${res.status}`);
      const data = await res.json();

      if (data.Answer && data.Answer.length > 0) {
        results[type] = data.Answer.map(a => ({
          name: a.name,
          type: type,
          ttl: a.TTL,
          data: a.data,
        }));
      } else {
        results[type] = [];
      }
    } catch (e) {
      errors.push(`${type}: ${e.message}`);
      results[type] = [];
    }
  }));

  // Summary stats
  const totalRecords = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  const typesWithRecords = Object.entries(results).filter(([_, arr]) => arr.length > 0).map(([t]) => t);

  return new Response(JSON.stringify({
    domain,
    records: results,
    summary: {
      totalRecords,
      typesFound: typesWithRecords,
      typesChecked: types,
    },
    errors: errors.length ? errors : undefined,
    checkedAt: new Date().toISOString(),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
