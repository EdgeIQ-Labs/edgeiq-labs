/**
 * EdgeIQ Inbox Triage - AI Draft Generator with RAG
 */

export async function generateDraft(email, classification, customerId, env) {
  const kbContext = await retrieveKBContext(email, classification, customerId, env);
  const prompt = buildDraftPrompt(email, classification, kbContext);

  try {
    const response = await fetch(env.LLM_GATEWAY_URL || 'https://jarvis.edgeiqlabs.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'qwen-3.5-plus',
        messages: [
          { role: 'system', content: DRAFT_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) throw new Error(`LLM gateway error: ${response.status}`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    const parsed = JSON.parse(content);
    return {
      text: parsed.reply_text || parsed.text || '',
      subject: parsed.subject || `Re: ${email.subject}`,
      tone: determineTone(classification),
      kbSources: kbContext.sources.map(s => s.docId)
    };
  } catch (err) {
    console.error('Draft generation failed:', err.message);
    return generateFallbackDraft(email, classification);
  }
}

const DRAFT_SYSTEM_PROMPT = `You are a professional email assistant for small businesses.
Generate draft replies that are:
- Professional but warm (not robotic)
- Concise (under 200 words unless complexity requires more)
- Action-oriented (clear next steps)
- Personalized (reference specific details from the original email)

Return JSON with:
- reply_text: The full draft reply body
- subject: Suggested reply subject line
- confidence: 0.0-1.0 how confident you are this addresses the inquiry

Rules:
- Never fabricate information not in the KB context or original email
- If KB context doesn't contain relevant info, acknowledge the question and suggest escalation
- For support issues: acknowledge problem, provide solution or ETA, offer follow-up
- For sales inquiries: thank them, answer pricing/feature questions from KB, suggest call/demo
- Always end with a clear next step or call-to-action`;

function buildDraftPrompt(email, classification, kbContext) {
  let prompt = `Draft a reply to this email:

From: ${email.from}
Subject: ${email.subject}
Category: ${classification.category}
Priority: ${classification.priority}
Sentiment: ${classification.sentiment}

Original message:
${(email.body || '').substring(0, 3000)}
`;
  if (kbContext.chunks.length > 0) {
    prompt += '\nRelevant knowledge base context:\n';
    for (const chunk of kbContext.chunks.slice(0, 5)) {
      prompt += `---\n${chunk.text}\n`;
    }
  } else {
    prompt += '\nNo relevant KB documents found. Draft a professional acknowledgment and suggest manual review.';
  }
  return prompt;
}

async function retrieveKBContext(email, classification, customerId, env) {
  const sources = [];
  const chunks = [];
  try {
    const keywords = extractKeywords(email, classification);
    for (const keyword of keywords.slice(0, 5)) {
      const results = await env.DB.prepare(
        `SELECT kc.*, kd.filename FROM kb_chunks kc
         JOIN kb_documents kd ON kc.document_id = kd.id
         WHERE kc.customer_id = ? AND kc.text_content LIKE ?
         LIMIT 3`
      ).bind(customerId, `%${keyword}%`).all();
      for (const row of results.results || []) {
        if (!chunks.find(c => c.chunkId === row.id)) {
          chunks.push({ chunkId: row.id, docId: row.document_id, filename: row.filename, text: row.text_content, score: 1.0 });
        }
      }
    }
    const uniqueDocs = [...new Set(chunks.map(c => c.docId))];
    sources.push(...uniqueDocs);
  } catch (err) {
    console.error('KB retrieval failed:', err.message);
  }
  return { chunks, sources };
}

function extractKeywords(email, classification) {
  const keywords = [];
  if (classification.entities) {
    if (classification.entities.product) keywords.push(classification.entities.product);
    if (classification.entities.company_name) keywords.push(classification.entities.company_name);
  }
  if (classification.category === 'support') keywords.push('troubleshoot', 'fix', 'solution', 'how to', 'error');
  else if (classification.category === 'sales') keywords.push('pricing', 'plan', 'features', 'cost', 'quote');
  const subjectWords = (email.subject || '').toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['this','that','with','from','have','been','will','would','could','about'].includes(w));
  keywords.push(...subjectWords.slice(0, 3));
  return [...new Set(keywords)];
}

function determineTone(classification) {
  if (classification.priority === 'P0') return 'urgent';
  if (classification.sentiment === 'frustrated' || classification.sentiment === 'negative') return 'apologetic';
  if (classification.category === 'sales') return 'friendly';
  return 'professional';
}

function generateFallbackDraft(email, classification) {
  const templates = {
    support: { text: `Hi,\n\nThank you for reaching out. We've received your message regarding "${email.subject}" and our team is reviewing it now.\n\nWe'll get back to you within 24 hours with a resolution or update. If this is urgent, please reply with "URGENT" and we'll prioritize accordingly.\n\nBest regards,\nThe Team`, subject: `Re: ${email.subject}`, tone: 'professional' },
    sales: { text: `Hi,\n\nThanks for your interest! I'd be happy to help with your inquiry about "${email.subject}".\n\nI've noted your questions and will send over detailed information shortly. In the meantime, feel free to browse our pricing page or schedule a quick demo call at your convenience.\n\nLooking forward to helping you find the right solution.\n\nBest regards,\nThe Team`, subject: `Re: ${email.subject}`, tone: 'friendly' }
  };
  const template = templates[classification.category] || templates.support;
  return { ...template, kbSources: [] };
}
