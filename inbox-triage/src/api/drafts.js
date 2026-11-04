/**
 * EdgeIQ Inbox Triage - Draft Management API
 * CRUD + approve/reject/edit/send for AI-generated drafts
 */

import { sendViaMailflare } from '../lib/mailflare.js';

export async function handleDrafts(path, request, env, customerId) {
  const method = request.method;

  // GET /api/drafts - list drafts
  if (path === '/api/drafts' && method === 'GET') {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'pending';
    const limit = parseInt(url.searchParams.get('limit') || '50');

    const drafts = await env.DB.prepare(
      `SELECT d.*, c.sender_email, c.subject as original_subject, c.category
       FROM drafts d
       JOIN classifications c ON d.classification_id = c.id
       WHERE d.customer_id = ? AND d.status = ?
       ORDER BY d.created_at DESC LIMIT ?`
    ).bind(customerId, status, limit).all();

    return new Response(JSON.stringify({ drafts: drafts.results || [] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // POST /api/drafts/:id/approve
  if (path.match(/\/api\/drafts\/[\w-]+\/approve/) && method === 'POST') {
    const draftId = path.split('/')[3];
    const draft = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND customer_id = ?').bind(draftId, customerId).first();
    if (!draft) return new Response('Not found', { status: 404 });

    // Get original email info
    const classification = await env.DB.prepare('SELECT * FROM classifications WHERE id = ?').bind(draft.classification_id).first();

    // Send the approved draft
    const mailbox = await env.DB.prepare('SELECT * FROM mailboxes WHERE customer_id = ? AND is_active = 1 LIMIT 1').bind(customerId).first();
    if (mailbox) {
      const result = await sendViaMailflare(env, mailbox.id, classification.sender_email, draft.suggested_subject, draft.draft_text);
      if (result.success) {
        await env.DB.prepare(
          `UPDATE drafts SET status = 'sent', sent_at = datetime('now'), sent_message_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(result.messageId, draftId).run();
        return new Response(JSON.stringify({ ok: true, sent: true, messageId: result.messageId }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Mark as approved even if send fails (user can retry)
    await env.DB.prepare(`UPDATE drafts SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(draftId).run();
    return new Response(JSON.stringify({ ok: true, approved: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // POST /api/drafts/:id/reject
  if (path.match(/\/api\/drafts\/[\w-]+\/reject/) && method === 'POST') {
    const draftId = path.split('/')[3];
    await env.DB.prepare(`UPDATE drafts SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND customer_id = ?`).bind(draftId, customerId).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  // PUT /api/drafts/:id/edit
  if (path.match(/\/api\/drafts\/[\w-]+\/edit/) && method === 'PUT') {
    const draftId = path.split('/')[3];
    const body = await request.json();
    await env.DB.prepare(
      `UPDATE drafts SET status = 'edited', human_edited_text = ?, updated_at = datetime('now') WHERE id = ? AND customer_id = ?`
    ).bind(body.text, draftId, customerId).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Not found', { status: 404 });
}
