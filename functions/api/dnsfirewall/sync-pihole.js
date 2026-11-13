/**
 * EdgeIQ DNS Firewall — Pi-hole Sync Engine
 * Pushes per-customer blocklists from D1 to both Pi-hole instances.
 */

const PIHOLES = [
  { name: 'PH1', url: 'http://10.5.1.117', password: 'admin' },
  { name: 'PH2', url: 'http://10.5.1.240', password: 'admin' },
];

async function phAuth(baseUrl, pw) {
  const r = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  const d = await r.json();
  return d?.session?.sid || null;
}

async function phGet(url, sid) {
  return (await fetch(url, { headers: { 'X-FTL-SID': sid } })).json();
}

async function phPost(url, sid, body) {
  return (await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
    body: JSON.stringify(body),
  })).json();
}

async function phPut(url, sid, body) {
  return (await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
    body: JSON.stringify(body),
  })).json();
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Auth gate for POST
  if (request.method === 'POST') {
    const key = request.headers.get('X-Internal-Key');
    const expected = env.DNSFW_INTERNAL_KEY || '3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
    if (key !== expected) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (!env.DNSFW_DB) {
    return new Response(JSON.stringify({ error: 'Database not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const customers = await env.DNSFW_DB.prepare(
      "SELECT id, email, tier FROM dnsfw_customers WHERE tier != 'free'"
    ).all();

    if (!customers.results || customers.results.length === 0) {
      return new Response(JSON.stringify({
        success: true, message: 'No active customers', synced: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const results = [];
    for (const cust of customers.results) {
      const bls = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_blocklists WHERE customer_id = ? AND enabled = 1'
      ).bind(cust.id).all();

      const cResult = { customerId: cust.id, piholeResults: {} };

      for (const ph of PIHOLES) {
        try {
          const sid = await phAuth(ph.url, ph.password);
          if (!sid) { cResult.piholeResults[ph.name] = { error: 'Auth failed' }; continue; }

          // Ensure customer group exists
          const groupName = `dnsfw_${cust.id}`;
          const groups = await phGet(`${ph.url}/api/groups`, sid);
          let groupId = (groups.groups || []).find(g => g.name === groupName)?.id;

          if (!groupId) {
            await phPost(`${ph.url}/api/groups`, sid, {
              name: groupName, comment: 'DNSFW customer', enabled: true,
            });
            const refreshed = await phGet(`${ph.url}/api/groups`, sid);
            groupId = (refreshed.groups || []).find(g => g.name === groupName)?.id;
          }

          if (!groupId) {
            cResult.piholeResults[ph.name] = { error: 'Group creation failed' };
            continue;
          }

          // Sync blocklists
          const currentLists = await phGet(`${ph.url}/api/lists`, sid);
          const currentAdlists = (currentLists.lists || []).filter(l => l.type === 'block');
          let added = 0, skipped = 0;

          for (const bl of (bls.results || [])) {
            if (!bl.source_url || !bl.enabled) continue;
            const existing = currentAdlists.find(l => l.address === bl.source_url);

            if (existing) {
              if (!existing.groups.includes(groupId)) {
                await phPut(`${ph.url}/api/lists/${encodeURIComponent(bl.source_url)}`, sid, {
                  groups: [...existing.groups, groupId], enabled: true,
                });
              }
              skipped++;
            } else {
              await phPost(`${ph.url}/api/lists`, sid, {
                address: bl.source_url,
                type: 'block',
                comment: `DNSFW ${cust.id}: ${bl.name}`,
                groups: [groupId],
                enabled: true,
              });
              added++;
            }
          }

          cResult.piholeResults[ph.name] = { groupId, added, skipped };
        } catch (e) {
          cResult.piholeResults[ph.name] = { error: e.message };
        }
      }

      results.push(cResult);
    }

    // Trigger gravity update on both Pi-holes
    const gravity = {};
    for (const ph of PIHOLES) {
      try {
        const sid = await phAuth(ph.url, ph.password);
        if (sid) {
          await phPost(`${ph.url}/api/action/gravity`, sid, {});
          gravity[ph.name] = 'triggered';
        }
      } catch (e) {
        gravity[ph.name] = e.message;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      synced: results.length,
      customers: results,
      gravity,
      timestamp: new Date().toISOString(),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('DNSFirewall Pi-hole sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
