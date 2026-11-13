/**
 * EdgeIQ StatusPage — Internal Incident Auto-Creation
 * Called by UptimePing cron when monitors change state
 * No auth required (internal-only, not exposed publicly)
 */

export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  // Only accept requests from our own cron (check internal header or same-origin)
  // In CF Pages, internal calls don't have special auth — we rely on the endpoint
  // not being documented publicly and checking a shared secret
  const internalKey = request.headers.get('X-Internal-Key');
  if (!env.STATUSPAGE_INTERNAL_KEY || internalKey !== env.STATUSPAGE_INTERNAL_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
  
  const { page_id, component_name, monitor_url, status, response_time_ms, error } = body;
  
  if (!page_id || !status) {
    return new Response('page_id and status required', { status: 400 });
  }
  
  try {
    // Find or create component for this monitor
    let component = await env.STATUSPAGE_DB.prepare(
      'SELECT id, status FROM components WHERE page_id = ? AND name = ?'
    ).bind(page_id, component_name || monitor_url).first();
    
    if (!component) {
      // Auto-create component
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
    
    // If going DOWN: create new incident
    if (status === 'down') {
      // Check for existing unresolved incident for this component
      const existing = await env.STATUSPAGE_DB.prepare(
        'SELECT id FROM incidents WHERE page_id = ? AND component_id = ? AND resolved_at IS NULL'
      ).bind(page_id, component.id).first();
      
      if (!existing) {
        const incidentId = crypto.randomUUID();
        const title = `${component_name || monitor_url} is down`;
        const bodyText = `Monitoring detected ${error || 'unreachable'} at ${new Date().toISOString()}. Response time: ${response_time_ms || 'N/A'}ms.`;
        
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incidents (id, page_id, component_id, title, body, status, severity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))'
        ).bind(incidentId, page_id, component.id, title, bodyText, 'investigating', 'critical').run();
        
        // Add initial timeline update
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
        ).bind(crypto.randomUUID(), incidentId, bodyText, 'investigating').run();
        
        console.log(`StatusPage: Auto-created incident for ${component_name || monitor_url}`);
      }
    }
    
    // If going UP: resolve any open incidents for this component
    if (status === 'up') {
      const openIncidents = await env.STATUSPAGE_DB.prepare(
        'SELECT id FROM incidents WHERE page_id = ? AND component_id = ? AND resolved_at IS NULL'
      ).bind(page_id, component.id).all();
      
      for (const inc of (openIncidents.results || [])) {
        const resolvedMsg = `Service recovered at ${new Date().toISOString()}. Response time: ${response_time_ms || 'N/A'}ms.`;
        
        await env.STATUSPAGE_DB.prepare(
          'UPDATE incidents SET status = "resolved", resolved_at = datetime("now"), updated_at = datetime("now") WHERE id = ?'
        ).bind(inc.id).run();
        
        await env.STATUSPAGE_DB.prepare(
          'INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
        ).bind(crypto.randomUUID(), inc.id, resolvedMsg, 'resolved').run();
        
        console.log(`StatusPage: Auto-resolved incident ${inc.id} for ${component_name || monitor_url}`);
      }
    }
    
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Auto-incident error:', e);
    return new Response('Internal error', { status: 500 });
  }
}
