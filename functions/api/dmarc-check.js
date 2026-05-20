/**
 * EdgeIQ — DMARC Record Checker
 * GET /api/dmarc-check?domain=example.com
 *
 * Checks DMARC, SPF, and MX records via Cloudflare DoH.
 * Returns parsed policy, tags, and risk level.
 */

const DOH = 'https://cloudflare-dns.com/dns-query';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function dnsQuery(name, type) {
  try {
    const r = await fetch(
      `${DOH}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(7000) }
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

function parseDmarcTags(record) {
  if (!record) return {};
  const tags = {};
  record.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) tags[k] = v;
    }
  });
  return tags;
}

function spfAllMechanism(record) {
  if (!record) return null;
  if (record.includes('-all')) return 'fail';
  if (record.includes('~all')) return 'softfail';
  if (record.includes('?all')) return 'neutral';
  if (record.includes('+all')) return 'pass';
  return 'none';
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

  const [dmarcResp, spfResp, mxResp, dkimGoogle, dkimMicrosoft] = await Promise.all([
    dnsQuery(`_dmarc.${domain}`, 'TXT'),
    dnsQuery(domain, 'TXT'),
    dnsQuery(domain, 'MX'),
    dnsQuery(`google._domainkey.${domain}`, 'TXT'),
    dnsQuery(`selector1._domainkey.${domain}`, 'TXT'),
  ]);

  const dmarcTxts   = getTxtValues(dmarcResp).filter(t => t.toLowerCase().startsWith('v=dmarc1'));
  const spfTxts     = getTxtValues(spfResp).filter(t => t.toLowerCase().startsWith('v=spf1'));
  const hasMx       = (mxResp.Answer || []).some(a => a.type === 15);
  const dkimGoogle_ = getTxtValues(dkimGoogle).some(t => t.toLowerCase().startsWith('v=dkim1'));
  const dkimMs_     = getTxtValues(dkimMicrosoft).some(t => t.toLowerCase().startsWith('v=dkim1'));

  const dmarcRecord = dmarcTxts[0] || null;
  const spfRecord   = spfTxts[0]   || null;
  const dmarcTags   = parseDmarcTags(dmarcRecord);
  const policy      = (dmarcTags.p || '').toLowerCase() || null;

  const riskLevel = !dmarcRecord        ? 'critical'
                  : policy === 'none'   ? 'high'
                  : policy === 'quarantine' ? 'medium'
                  : policy === 'reject' ? 'low'
                  : 'high';

  return Response.json({
    domain,
    dmarc: {
      found:   !!dmarcRecord,
      record:  dmarcRecord,
      policy,
      tags:    dmarcTags,
      rua:     dmarcTags.rua  || null,
      ruf:     dmarcTags.ruf  || null,
      pct:     dmarcTags.pct  ? parseInt(dmarcTags.pct, 10) : null,
      sp:      dmarcTags.sp   || null,
      adkim:   dmarcTags.adkim || null,
      aspf:    dmarcTags.aspf  || null,
    },
    spf: {
      found:  !!spfRecord,
      record: spfRecord,
      all:    spfAllMechanism(spfRecord),
    },
    dkim: {
      google:    dkimGoogle_,
      microsoft: dkimMs_,
      found:     dkimGoogle_ || dkimMs_,
    },
    mx:   { found: hasMx },
    risk: {
      can_be_spoofed: riskLevel === 'critical' || riskLevel === 'high',
      level: riskLevel,
    },
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
}
