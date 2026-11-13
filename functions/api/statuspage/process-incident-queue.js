/**
 * EdgeIQ StatusPage — Incident Queue Processor
 * Lightweight cron (every 15 min) that drains pending auto-incidents from KV
 * Separated from UptimePing cron to stay within free tier CPU limits
 */

export async function onRequest(context) {
  const { env } = context;
  
  if (!env.STATUSPAGE_DB) {
    return new Response(JSON.stringify({ error: 'STATUSPAGE_DB not bound' }), { status: 500 });
  }
  
  // Drain queue (max 10 per run to stay well under CPU limit)
  const queueRaw = await env.PULSE_KV.get('statuspage:incident-queue');
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  
  if (queue.length === 0) {
    return new Response(JSON.stringify({ processed: 0, remaining: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  
  const batch = queue.slice(0, 10);
  const remaining = queue.slice(10);
  let processed = 0;
  let errors = 0;
  
  for (const item of batch) {
    try {
      await processIncident(env, item);
      processed++;
    } catch (e) {
      console.error('Queue processor error:', e.message);
      errors++;
    }
  }
  
  // Update queue with unprocessed items
  if (remaining.length > 0) {
    await env.PULSE_KV.put('statuspage:incident-queue', JSON.stringify(remaining));
  } else {
    await env.PULSE_KV.delete('statuspage:incident-queue');
  }
  
  return new Response(JSON.stringify({ processed, errors, remaining: remaining.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processIncident(env, item) {
  const { owner_email, component_name, monitor_url, status, response_time_ms, error } = item;
  
  // Find all pages owned by this subscriber
  const pages = await env.STATUSPAGE_DB.prepare(
    'SELECT id FROM pages WHERE owner_email = ?'
  ).bind(owner_email).all();
  
  if (!pages.results || pages.results.length === 0) return;
  
  for (const page of pages.results) {
    const page_id = page.id;
    
    // Find or create component
    let component = await env.STATUSPAGE_DB.prepare(
      'SELECT id, status FROM components WHERE page_id = ? AND name = ?'
    ).bind(page_id, component_name || monitor_url).first();
    
    if (!component) {
      const compId = crypto.randomUUID();
      await env.STATUSPAGE_DB.prepare(
        'INSERT INTO components (id, page_id, name, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(compId, page_id, component_name || monitor_url, monitor_url, 'operational', 999).run();
      component = { id: compId, status: 'operational' };
    }
    
    // Update component status
    const newComponentStatus = status === 'down' ? 'major_outage' : 'operational';
    if (component.status !== newComponentStatus) {
      await env.STATUSPAGE_DB.prepare(
        'UPDATE components SET status = ?, updated_at = datetime("now") WHERE id = ?'
      ).bind(newComponentStatus, component.id).run();
    }
    
    if (status === 'down') {
      // Check for existing unresolved incident
      const allOpen = await env.STATUSPAGE_DB.prepare(
        'SELECT id, affected_components FROM incidents WHERE page_id = ? AND resolved_at IS NULL'
      ).bind(page_id).all();
      const existing = (allOpen.results || []).find(i => {
        try { const ids = JSON.parse(i.affected_components || '[]'); return ids.includes(component.id); } catch { return false; }
      });
      
      if (!existing) {
        const incidentId = crypto.randomUUID();
        const title = `${component_name || monitor_url} is down`;
        const bodyText = `Monitoring detected ${error || 'unreachable'} at ${new Date().toISOString()}. Response time: ${response_time_ms || 'N/A'}ms.`;
        
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incidents (id, page_id, title, body, status, severity, affected_components, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))'
        ).bind(incidentId, page_id, title, bodyText, 'investigating', 'critical', JSON.stringify([component.id])).run();
        
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
        ).bind(crypto.randomUUID(), incidentId, bodyText, 'investigating').run();
      }
    }
    
    if (status === 'up') {
      const allOpenUp = await env.STATUSPAGE_DB.prepare(
        'SELECT id, affected_components FROM incidents WHERE page_id = ? AND resolved_at IS NULL'
      ).bind(page_id).all();
      const openIncidents = (allOpenUp.results || []).filter(i => {
        try { const ids = JSON.parse(i.affected_components || '[]'); return ids.includes(component.id); } catch { return false; }
      });
      
      for (const inc of openIncidents) {
        const resolvedMsg = `Service recovered at ${new Date().toISOString()}. Response time: ${response_time_ms || 'N/A'}ms.`;
        
        await env.STATUSPAGE_DB.prepare(
          'UPDATE incidents SET status = "resolved", resolved_at = datetime("now"), updated_at = datetime("now") WHERE id = ?'
        ).bind(inc.id).run();
        
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
        ).bind(crypto.randomUUID(), inc.id, resolvedMsg, 'resolved').run();
      }
    }
  }
}
