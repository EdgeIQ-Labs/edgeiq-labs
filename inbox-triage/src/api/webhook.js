/**
 * EdgeIQ Inbox Triage - Inbound Email Webhook
 * Receives email from Mailflare, classifies, routes, and optionally drafts reply
 */

import { classifyEmail } from '../lib/classifier.js';
import { generateDraft } from '../lib/drafter.js';
import { routeEmail } from '../lib/router.js';
import { recordUsage } from '../lib/stripe.js';

export async function handleWebhook(request, env) {
  const signature = request.headers.get('x-mailflare-signature');
  if (!signature || !await verifySignature(request, signature, env.WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const payload = await request.json();
  
  const email = {
    messageId: payload.message_id,
    from: payload.from?.email || payload.sender,
    fromName: payload.from?.name,
    to: payload.to?.[0]?.email || payload.recipient,
    subject: payload.subject,
    body: payload.text || payload.html || '',
    headers: payload.headers || {},
    receivedAt: payload.received_at || new Date().toISOString()
  };

  const mailbox = await env.DB.prepare(
    'SELECT m.*, c.id as customer_id, c.plan, c.status, c.monthly_limit, c.emails_triaged FROM mailboxes m JOIN customers c ON m.customer_id = c.id WHERE m.mailbox_external_id = ? AND m.is_active = 1'
  ).bind(payload.mailbox_id).first();

  if (!mailbox) {
    return new Response('OK', { status: 200 });
  }

  if (mailbox.status !== 'active') {
    return new Response('OK', { status: 200 });
  }

  if (mailbox.plan === 'starter' && mailbox.emails_triaged >= mailbox.monthly_limit) {
    return new Response('OK', { status: 200 });
  }

  const classification = await classifyEmail(email, env);
  
  const classId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO classifications (id, customer_id, mailbox_id, message_id, sender_email, sender_name, subject, category, priority, sentiment, entities, confidence, llm_model, llm_cost_usd, raw_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    classId, mailbox.customer_id, mailbox.id, email.messageId,
    email.from, email.fromName, email.subject,
    classification.category, classification.priority, classification.sentiment,
    JSON.stringify(classification.entities), classification.confidence,
    classification.llm_model, classification.llm_cost_usd, classification.raw_response
  ).run();

  await env.DB.prepare(
    'UPDATE customers SET emails_triaged = emails_triaged + 1, updated_at = datetime("now") WHERE id = ?'
  ).bind(mailbox.customer_id).run();

  await recordUsage(env, mailbox.customer_id, 'email_classified', { category: classification.category, priority: classification.priority });

  await routeEmail(email, classification, mailbox, env);

  if (mailbox.plan === 'pro' && ['support', 'sales'].includes(classification.category)) {
    try {
      const draft = await generateDraft(email, classification, mailbox.customer_id, env);
      const draftId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO drafts (id, classification_id, customer_id, status, draft_text, suggested_subject, tone, kb_sources_used)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
      ).bind(
        draftId, classId, mailbox.customer_id,
        draft.text, draft.subject, draft.tone,
        JSON.stringify(draft.kbSources || [])
      ).run();
      await recordUsage(env, mailbox.customer_id, 'draft_generated', { category: classification.category });
    } catch (err) {
      console.error(`Draft generation failed for ${classId}:`, err.message);
    }
  }

  if (classification.priority === 'P0') {
    await sendAlert(email, classification, mailbox, env);
  }

  await env.DB.prepare(
    `INSERT INTO audit_log (id, customer_id, action, resource_type, resource_id, actor, details)
     VALUES (?, ?, 'classify', 'email', ?, 'system', ?)`
  ).bind(
    crypto.randomUUID(), mailbox.customer_id, classId,
    JSON.stringify({ category: classification.category, priority: classification.priority, from: email.from })
  ).run();

  return new Response(JSON.stringify({ 
    ok: true, 
    classification: classification.category,
    priority: classification.priority,
    id: classId 
  }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

async function verifySignature(request, signature, secret) {
  if (!secret) return true;
  const body = await request.clone().text();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === signature;
}

async function sendAlert(email, classification, mailbox, env) {
  const alertPayload = {
    title: `🚨 P0 Alert: ${classification.category.toUpperCase()}`,
    body: `From: ${email.from}\nSubject: ${email.subject}\n\n${(email.body || '').substring(0, 200)}...`,
    group: 'inbox-triage-p0'
  };

  if (env.BARK_KEY) {
    try {
      await fetch(`https://api.day.app/${env.BARK_KEY}/${encodeURIComponent(alertPayload.title)}/${encodeURIComponent(alertPayload.body)}?group=${alertPayload.group}`, { method: 'GET' });
    } catch (e) {
      console.error('Bark alert failed:', e.message);
    }
  }

  if (env.NTFY_TOPIC) {
    try {
      await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
        method: 'POST',
        body: alertPayload.body,
        headers: { 'Title': alertPayload.title, 'Priority': 'max', 'Tags': 'rotating_light' }
      });
    } catch (e) {
      console.error('ntfy alert failed:', e.message);
    }
  }
}
