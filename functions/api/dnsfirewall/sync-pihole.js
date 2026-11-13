/**
 * EdgeIQ DNS Firewall — Pi-hole Sync Engine
 * Pushes per-customer blocklists from D1 to both Pi-hole instances.
 * Called by cron or manually after blocklist changes.
 *
 * Architecture:
 * - Each customer gets a Pi-hole group named "dnsfw_<customerId>"
 * - Customer's blocklists are added as adlists assigned to that group
 * - Gravity update runs after sync to apply changes
 */

const PIHOLES = [
  { name: 'PH1', url: 'http://10.5.1.117', password: 'admin' },
  { name: 'PH2', url: 'http://10.5.1.240', password: 'admin' },
];

async function phAuth(baseUrl, password) {
  const res = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  return data?.session?.sid || null;
}

async function phGet(url, sid) {
  const res = await fetch(url, { headers: { 'X-FTL-SID': sid } });
  return res.json();
}

async function phPost(url, sid, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function phPut(url, sid, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-FTL-SID': sid },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function phDelete(url, sid) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-FTL-SID': sid },
  });
  return res.ok;
}

async function ensureGroup(sid, baseUrl, groupName) {
  const groups = await phGet(`${baseUrl}/api/groups`, sid);
  const existing = (groups.groups || []).find(g => g.name === groupName);
  if (existing) return existing.id;

  const created = await phPost(`${baseUrl}/api/groups`, sid, {
    name: groupName,
    comment: 'EdgeIQ DNS Firewall customer group',
    enabled: true,
  });
  // Return the new group's ID from the response or re-fetch
  if (created?.group?.id !== undefined) return created.group.id;
  // Fallback: re-fetch groups to find the newly created one
  const refreshed = await phGet(`${baseUrl}/api/groups`, sid);
  const found = (refreshed.groups || []).find(g => g.name === groupName);
  return found?.id ?? null;
}

async function syncBlocklistsForCustomer(sid, baseUrl, customerId, blocklists) {
  const groupName = `dnsfw_${customerId}`;
  const groupId = await ensureGroup(sid, baseUrl, groupName);
  if (groupId === null) return { error: 'Failed to create/find group' };

  // Get current adlists
  const currentLists = await phGet(`${baseUrl}/api/lists`, sid);
  const currentAdlists = (currentLists.lists || []).filter(l => l.type === 'block');

  let added = 0;
  let skipped = 0;

  for (const bl of blocklists) {
    if (!bl.source_url || !bl.enabled) continue;

    // Check if this URL already exists in adlists
    const existing = currentAdlists.find(l => l.address === bl.source_url);
    if (existing) {
      // Ensure it's assigned to our customer group
      if (!existing.groups.includes(groupId)) {
        const updatedGroups = [...existing.groups, groupId];
        await phPut(`${baseUrl}/api/lists/${encodeURIComponent(bl.source_url)}`, sid, {
          groups: updatedGroups,
          enabled: true,
        });
      }
      skipped++;
      continue;
    }

    // Add new adlist assigned to customer group
    await phPost(`${baseUrl}/api/lists`, sid, {
      address: bl.source_url,
      type: 'block',
      comment: `DNSFW customer ${customerId}: ${bl.name}`,
      groups: [groupId],
      enabled: true,
    });
    added++;
  }

  return { groupId, added, skipped, total: blocklists.length };
}

export async function onRequest(context) {
  const { request, env } = context;

  // Allow GET (cron) or POST (manual trigger)
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Auth gate for manual triggers
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
    // Get all active customers with paid tiers
    const customers = await env.DNSFW_DB.prepare(
      'SELECT id, email, tier FROM dnsfw_customers WHERE tier != \'free\''
    ).all();

    if (!customers.results || customers.results.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No active customers to sync',
        synced: 0,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const results = [];

    for (const customer of customers.results) {
      // Get customer's enabled blocklists
      const blocklists = await env.DNSFW_DB.prepare(
        'SELECT * FROM dnsfw_blocklists WHERE customer_id = ? AND enabled = 1'
      ).bind(customer.id).all();

      const customerResult = { customerId: customer.id, email: customer.email, piholeResults: {} };

      // Sync to each Pi-hole
      for (const ph of PIHOLES) {
        try {
          const sid = await phAuth(ph.url, ph.password);
          if (!sid) {
            customerResult.piholeResults[ph.name] = { error: 'Auth failed' };
            continue;
          }

          const syncResult = await syncBlocklistsForCustomer(
            sid, ph.url, customer.id, blocklists.results || []
          );
          customerResult.piholeResults[ph.name] = syncResult;
        } catch (e) {
          customerResult.piholeResults[ph.name] = { error: e.message };
        }
      }

      results.push(customerResult);
    }

    // Trigger gravity update on both Pi-holes (non-blocking)
    const gravityResults = {};
    for (const ph of PIHOLES) {
      try {
        const sid = await phAuth(ph.url, ph.password);
        if (sid) {
          await phPost(`${ph.url}/api/action/gravity`, sid, {});
          gravityResults[ph.name] = 'triggered';
        }
      } catch (e) {
        gravityResults[ph.name] = e.message;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      synced: results.length,
      customers: results,
      gravity: gravityResults,
      timestamp: new Date().toISOString(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('DNSFirewall Pi-hole sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
