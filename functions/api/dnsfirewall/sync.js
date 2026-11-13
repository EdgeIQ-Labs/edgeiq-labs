/**
 * EdgeIQ DNS Firewall — Pi-hole Sync Engine
 * Pushes per-customer blocklists from D1 to both Pi-hole instances.
 */

const PIHOLES = [
  { name: 'PH1', url: 'http://10.5.1.117', password: 'admin' },
  { name: 'PH2', url: 'http://10.5.1.240', password: 'admin' },
];

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

  // ── Push mode: POST with piholes state from local agent ──
  const url = new URL(request.url);
  if (request.method === 'POST' && request.headers.get('Content-Type')?.includes('application/json')) {
    const key = request.headers.get('X-Internal-Key');
    const expected = env.DNSFW_INTERNAL_KEY || '3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
    if (key !== expected) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    // Check if this is a push from local agent (has piholes field) vs seed request
    const bodyText = await request.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

    if (body.pihole && !url.searchParams.get('seed')) {
      // Local agent push: store Pi-hole state snapshot in D1 for dashboard display
      const timestamp = new Date().toISOString();
      for (const [phName, phData] of Object.entries(body.pihole || {})) {
        if (phData.error) continue;
        // Store as KV-like entry in stats table for monitoring
        await env.DNSFW_DB.prepare(
          "INSERT OR REPLACE INTO dnsfw_stats_hourly (customer_id, hour, total_queries, blocked_queries) VALUES (?, ?, 0, 0)"
        ).bind('system', timestamp.slice(0, 13)).run();
      }
      return new Response(JSON.stringify({ success: true, message: 'Pi-hole state received', timestamp }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Re-parse for seed check below
    if (url.searchParams.get('seed') === 'true') {
    const key = request.headers.get('X-Internal-Key');
    const expected = env.DNSFW_INTERNAL_KEY || '3b36a0d8f2e1c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9';
    if (key !== expected) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    await env.DNSFW_DB.prepare("INSERT OR REPLACE INTO dnsfw_customers (id, email, tier, max_devices, max_blocklists, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").bind('test-cust-001', 'cypher@edgeiqlabs.com', 'personal', 10, 10).run();
    await env.DNSFW_DB.prepare("INSERT OR REPLACE INTO dnsfw_blocklists (id, customer_id, name, category, source_url, enabled) VALUES (?, ?, ?, ?, ?, 1)").bind('bl-001', 'test-cust-001', 'StevenBlack Unified', 'ads', 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts').run();
    await env.DNSFW_DB.prepare("INSERT OR REPLACE INTO dnsfw_blocklists (id, customer_id, name, category, source_url, enabled) VALUES (?, ?, ?, ?, ?, 1)").bind('bl-002', 'test-cust-001', 'OISD Big', 'malware', 'https://big.oisd.nl/domainswild').run();

    const custs = await env.DNSFW_DB.prepare('SELECT id, email, tier FROM dnsfw_customers').all();
    const bls = await env.DNSFW_DB.prepare('SELECT id, name, category FROM dnsfw_blocklists').all();
    return new Response(JSON.stringify({ success: true, seeded: { customers: custs.results, blocklists: bls.results } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
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
          // Auth
          const authR = await fetch(`${ph.url}/api/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: ph.password }),
          });
          const authD = await authR.json();
          const sid = authD?.session?.sid || null;
          if (!sid) { cResult.piholeResults[ph.name] = { error: 'Auth failed' }; continue; }

          const groupName = `dnsfw_${cust.id}`;
          const groupsR = await fetch(`${ph.url}/api/groups`, { headers: { 'X-FTL-SID': sid } });
          const groupsD = await groupsR.json();
          let groupId = (groupsD.groups || []).find(g => g.name === groupName)?.id;
          if (!groupId) {
            await fetch(`${ph.url}/api/groups`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
              body: JSON.stringify({ name: groupName, comment: 'DNSFW customer', enabled: true }),
            });
            const refreshR = await fetch(`${ph.url}/api/groups`, { headers: { 'X-FTL-SID': sid } });
            const refreshD = await refreshR.json();
            groupId = (refreshD.groups || []).find(g => g.name === groupName)?.id;
          }
          if (!groupId) { cResult.piholeResults[ph.name] = { error: 'Group creation failed' }; continue; }

          const listsR = await fetch(`${ph.url}/api/lists`, { headers: { 'X-FTL-SID': sid } });
          const listsD = await listsR.json();
          const currentAdlists = (listsD.lists || []).filter(l => l.type === 'block');
          let added = 0, skipped = 0;

          for (const bl of (bls.results || [])) {
            if (!bl.source_url || !bl.enabled) continue;
            const existing = currentAdlists.find(l => l.address === bl.source_url);
            if (existing) {
              if (!existing.groups.includes(groupId)) {
                await fetch(`${ph.url}/api/lists/${encodeURIComponent(bl.source_url)}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
                  body: JSON.stringify({ groups: [...existing.groups, groupId], enabled: true }),
                });
              }
              skipped++;
            } else {
              await fetch(`${ph.url}/api/lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
                body: JSON.stringify({
                  address: bl.source_url,
                  type: 'block',
                  comment: `DNSFW ${cust.id}: ${bl.name}`,
                  groups: [groupId],
                  enabled: true,
                }),
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
        const authR = await fetch(`${ph.url}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: ph.password }),
        });
        const authD = await authR.json();
        const sid = authD?.session?.sid || null;
        if (sid) {
          await fetch(`${ph.url}/api/action/gravity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
            body: JSON.stringify({}),
          });
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
