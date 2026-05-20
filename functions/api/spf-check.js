/**
 * EdgeIQ — SPF Record Checker
 * GET /api/spf-check?domain=example.com
 *
 * Deep SPF analysis:
 *   - Parses all mechanisms and qualifiers
 *   - Counts DNS-consuming lookups (10-lookup limit)
 *   - Identifies all/qualifier
 *   - Flags common misconfigurations
 *   - Returns structured breakdown for the UI
 */

const DOH = 'https://cloudflare-dns.com/dns-query';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// DNS mechanisms that consume a lookup each
const DNS_LOOKUP_MECHANISMS = ['include', 'a', 'mx', 'ptr', 'exists', 'redirect'];

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

/**
 * Parse an SPF record string into structured mechanisms
 */
function parseMechanisms(record) {
  if (!record) return [];
  const parts = record.trim().split(/\s+/);
  const mechanisms = [];

  for (const part of parts) {
    if (part.toLowerCase() === 'v=spf1') {
      mechanisms.push({ type: 'version', raw: part, qualifier: null, value: null, dnsLookup: false });
      continue;
    }

    // Qualifier
    let qualifier = '+'; // default pass
    let rest = part;
    if (['+', '-', '~', '?'].includes(part[0])) {
      qualifier = part[0];
      rest = part.slice(1);
    }

    const lower = rest.toLowerCase();
    const colonIdx = rest.indexOf(':');
    const slashIdx = rest.indexOf('/');
    const eqIdx = rest.indexOf('=');

    let mechType = rest;
    let value = null;

    if (colonIdx > 0) {
      mechType = rest.slice(0, colonIdx).toLowerCase();
      value = rest.slice(colonIdx + 1);
    } else if (eqIdx > 0) {
      mechType = rest.slice(0, eqIdx).toLowerCase();
      value = rest.slice(eqIdx + 1);
    } else if (slashIdx > 0 && (lower.startsWith('ip4') || lower.startsWith('ip6'))) {
      mechType = lower.slice(0, slashIdx < 3 ? slashIdx : 3) || lower;
      value = rest;
    } else {
      mechType = lower;
    }

    const dnsLookup = DNS_LOOKUP_MECHANISMS.includes(mechType);
    mechanisms.push({ type: mechType, qualifier, value, raw: part, dnsLookup });
  }

  return mechanisms;
}

/**
 * Expand a single include: directive to get its SPF record
 */
async function expandInclude(domain) {
  const resp = await dnsQuery(domain, 'TXT');
  const records = getTxtValues(resp).filter(v => v.startsWith('v=spf1'));
  return records[0] || null;
}

/**
 * Count total DNS lookups (including nested includes, up to depth 2)
 */
async function countDnsLookups(mechanisms, depth = 0) {
  if (depth > 2) return { count: 0, includes: [] };

  let count = 0;
  const includes = [];

  for (const m of mechanisms) {
    if (!m.dnsLookup) continue;
    count++;

    if (m.type === 'include' && m.value && depth < 2) {
      try {
        const nested = await expandInclude(m.value);
        if (nested) {
          const nestedMechs = parseMechanisms(nested);
          const nestedResult = await countDnsLookups(nestedMechs, depth + 1);
          count += nestedResult.count;
          includes.push({ domain: m.value, record: nested, lookups: nestedResult.count + 1, nested: nestedResult.includes });
        } else {
          includes.push({ domain: m.value, record: null, lookups: 1, nested: [] });
        }
      } catch {
        includes.push({ domain: m.value, record: null, lookups: 1, nested: [] });
      }
    }
  }

  return { count, includes };
}

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!domain || !domain.includes('.') || domain.length < 4) {
    return Response.json({ error: 'Please provide a valid domain (e.g. example.com)' }, { status: 400, headers: CORS });
  }

  // Fetch TXT records
  const resp = await dnsQuery(domain, 'TXT');
  const allTxt = getTxtValues(resp);
  const spfRecords = allTxt.filter(v => v.startsWith('v=spf1'));

  // Multiple SPF records = misconfiguration
  if (spfRecords.length > 1) {
    return Response.json({
      domain, found: true, error_type: 'multiple_records',
      records: spfRecords,
      issues: [{
        level: 'fail',
        message: 'Multiple SPF records found',
        detail: `Your domain has ${spfRecords.length} SPF records. RFC 7208 requires exactly one. Having multiple causes SPF to fail permanently for all senders.`,
        fix: 'Merge all your SPF records into a single TXT record. Delete the duplicates.',
      }],
    }, { status: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
  }

  if (spfRecords.length === 0) {
    return Response.json({
      domain, found: false,
      record: null,
      mechanisms: [],
      allQualifier: null,
      dnsLookups: 0,
      issues: [{
        level: 'fail',
        message: 'No SPF record found',
        detail: 'Your domain has no SPF record. This means any mail server can claim to send email from your domain and pass SPF.',
        fix: `Add a TXT record to your DNS: v=spf1 include:[your-mail-provider] -all\n\nCommon provider includes:\n• Google Workspace: include:_spf.google.com\n• Microsoft 365: include:spf.protection.outlook.com\n• Mailchimp: include:servers.mcsv.net`,
      }],
    }, { status: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
  }

  const record = spfRecords[0];
  const mechanisms = parseMechanisms(record);

  // Count DNS lookups (async, expands includes)
  const { count: lookupCount, includes: expandedIncludes } = await countDnsLookups(mechanisms);

  // Find all mechanism
  const allMech = mechanisms.find(m => m.type === 'all');
  const allQualifier = allMech ? allMech.qualifier : null;

  // Build issues list
  const issues = [];

  if (allQualifier === '+') {
    issues.push({
      level: 'fail',
      message: '+all — allows any sender to pass SPF',
      detail: 'Your SPF record ends with +all, which means any mail server in the world is authorized to send email from your domain. This completely defeats the purpose of SPF.',
      fix: 'Change +all to -all. List your legitimate sending sources explicitly using include: or ip4: mechanisms first.',
    });
  } else if (!allQualifier) {
    issues.push({
      level: 'warn',
      message: 'No "all" mechanism — undefined behaviour for unknown senders',
      detail: 'Your SPF record has no catch-all mechanism (-all, ~all, ?all). Receiving mail servers may handle unlisted senders unpredictably.',
      fix: 'Add -all at the end of your SPF record to explicitly reject unauthorized senders.',
    });
  } else if (allQualifier === '~') {
    issues.push({
      level: 'warn',
      message: '~all (softfail) — unauthorized senders marked but not rejected',
      detail: 'Soft fail (~all) marks unauthorized senders as suspicious but still allows delivery. Most receiving servers don\'t reject softfail messages.',
      fix: 'Consider upgrading to -all (hardfail) once you\'ve confirmed all legitimate senders are covered by your SPF record.',
    });
  }

  if (lookupCount > 10) {
    issues.push({
      level: 'fail',
      message: `SPF DNS lookup limit exceeded (${lookupCount} lookups, limit is 10)`,
      detail: `Your SPF record causes ${lookupCount} DNS lookups when evaluated. RFC 7208 hard-limits this to 10. When exceeded, SPF evaluation returns a PermError — meaning SPF permanently fails for all senders, regardless of whether they\'re authorized.`,
      fix: 'Use SPF flattening to replace include: directives with explicit ip4: ranges. Tools like EasyDMARC or Valimail can automate this. Alternatively, remove unused include: directives.',
    });
  } else if (lookupCount >= 8) {
    issues.push({
      level: 'warn',
      message: `Approaching DNS lookup limit (${lookupCount}/10 lookups)`,
      detail: `You\'re using ${lookupCount} of the 10 allowed DNS lookups. Adding new mail services (ESPs, CRMs) could push you over the limit and break SPF for all senders.`,
      fix: 'Review your include: directives and remove any for services you no longer use. Consider SPF flattening to give yourself headroom.',
    });
  }

  // Check for ptr mechanism (deprecated)
  if (mechanisms.some(m => m.type === 'ptr')) {
    issues.push({
      level: 'warn',
      message: 'ptr mechanism used — deprecated and slow',
      detail: 'The ptr mechanism is deprecated in RFC 7208 and causes slow, unreliable SPF evaluation. It should not be used.',
      fix: 'Replace the ptr mechanism with explicit ip4: or ip6: ranges for the IP addresses you want to authorize.',
    });
  }

  // Qualifier descriptions
  const qualifierDesc = { '+': 'Pass', '-': 'Fail', '~': 'SoftFail', '?': 'Neutral' };

  // Annotate mechanisms for display
  const annotated = mechanisms.map(m => ({
    ...m,
    qualifierLabel: m.qualifier ? (qualifierDesc[m.qualifier] || m.qualifier) : null,
    isGood: m.type === 'all' && m.qualifier === '-',
    isWarn: m.type === 'all' && m.qualifier === '~',
    isBad: (m.type === 'all' && m.qualifier === '+') || m.type === 'ptr',
  }));

  return Response.json({
    domain,
    found: true,
    record,
    mechanisms: annotated,
    allQualifier,
    dnsLookups: lookupCount,
    dnsLookupLimit: 10,
    expandedIncludes,
    issues,
    summary: issues.length === 0
      ? 'SPF record is well-configured.'
      : `${issues.filter(i => i.level === 'fail').length} critical issue(s), ${issues.filter(i => i.level === 'warn').length} warning(s) found.`,
  }, { status: 200, headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
}
