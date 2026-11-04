/**
 * EdgeIQ Inbox Triage - Manual Reclassification Endpoint
 */

export async function handleClassify(path, request, env, customerId) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await request.json();
  const { classificationId, newCategory, newPriority } = body;

  if (!classificationId) return new Response('Missing classificationId', { status: 400 });

  // Verify ownership
  const existing = await env.DB.prepare(
    'SELECT * FROM classifications WHERE id = ? AND customer_id = ?'
  ).bind(classificationId, customerId).first();

  if (!existing) return new Response('Not found', { status: 404 });

  const updates = [];
  const binds = [];
  if (newCategory) { updates.push('category = ?'); binds.push(newCategory); }
  if (newPriority) { updates.push('priority = ?'); binds.push(newPriority); }
  updates.push('confidence = 1.0'); // Human override = full confidence

  binds.push(classificationId);
  await env.DB.prepare(
    `UPDATE classifications SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  // Audit log
  await env.DB.prepare(
    `INSERT INTO audit_log (id, customer_id, action, resource_type, resource_id, actor, details)
     VALUES (?, ?, 'reclassify', 'email', ?, 'user', ?)`
  ).bind(crypto.randomUUID(), customerId, classificationId, JSON.stringify({ newCategory, newPriority })).run();

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
