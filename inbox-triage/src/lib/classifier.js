/**
 * EdgeIQ Inbox Triage - Email Classifier
 * Uses LLM gateway (Dialagram/Jarvis) to categorize and extract entities
 */

const CATEGORIES = ['support', 'sales', 'spam', 'internal', 'urgent', 'newsletter', 'other'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/**
 * Classify an inbound email using LLM
 * @param {Object} email - { from, subject, body, headers }
 * @param {Object} env - Worker env bindings
 * @returns {Object} { category, priority, sentiment, entities, confidence, cost }
 */
export async function classifyEmail(email, env) {
  const prompt = buildClassifierPrompt(email);
  
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 512,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`LLM gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('Empty LLM response');
    }

    const parsed = JSON.parse(content);
    
    // Validate and normalize output
    return {
      category: CATEGORIES.includes(parsed.category) ? parsed.category : 'other',
      priority: PRIORITIES.includes(parsed.priority) ? parsed.priority : 'P2',
      sentiment: parsed.sentiment || 'neutral',
      entities: parsed.entities || {},
      confidence: Math.min(1.0, Math.max(0.0, parseFloat(parsed.confidence) || 0.7)),
      raw_response: content,
      llm_model: data.model || env.LLM_MODEL || 'qwen-3.5-plus',
      llm_cost_usd: estimateCost(data.usage)
    };

  } catch (err) {
    console.error('Classification failed:', err.message);
    // Fallback: keyword-based classification
    return fallbackClassify(email);
  }
}

const SYSTEM_PROMPT = `You are an email classification engine for small business inbox triage.
Analyze each email and return a JSON object with exactly these fields:
- category: one of [support, sales, spam, internal, urgent, newsletter, other]
- priority: one of [P0, P1, P2, P3] where P0=critical/urgent, P1=high, P2=normal, P3=low
- sentiment: one of [positive, neutral, negative, frustrated]
- entities: object with keys like company_name, person_name, product, amount, deadline, ticket_id
- confidence: float 0.0-1.0 indicating your confidence in the classification

Rules:
- P0: security alerts, outage reports, legal threats, payment failures
- P1: customer complaints, billing issues, partnership inquiries
- P2: general questions, feature requests, routine correspondence
- P3: newsletters, marketing, automated notifications, spam
- If unsure between categories, prefer 'other' over guessing
- Extract specific entities when present (company names, dollar amounts, dates)`;

function buildClassifierPrompt(email) {
  return `Classify this email:

From: ${email.from || 'unknown'}
Subject: ${email.subject || '(no subject)'}
Body:
${(email.body || '').substring(0, 4000)}

Return JSON only, no markdown fences.`;
}

function estimateCost(usage) {
  if (!usage) return 0.002; // Default estimate
  // Qwen-3.5-plus pricing: ~$0.0005/1K input, $0.002/1K output
  const inputCost = (usage.prompt_tokens || 500) / 1000 * 0.0005;
  const outputCost = (usage.completion_tokens || 200) / 1000 * 0.002;
  return Math.round((inputCost + outputCost) * 1000000) / 1000000;
}

/**
 * Fallback keyword-based classification when LLM is unavailable
 */
function fallbackClassify(email) {
  const subject = (email.subject || '').toLowerCase();
  const body = (email.body || '').toLowerCase();
  const combined = `${subject} ${body}`;

  // P0 keywords
  if (/urgent|critical|emergency|outage|down|security|breach|legal|lawsuit|payment fail/i.test(combined)) {
    return { category: 'urgent', priority: 'P0', sentiment: 'negative', entities: {}, confidence: 0.6, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
  }

  // Support keywords
  if (/help|issue|problem|bug|error|ticket|support|how do i|can't|broken/i.test(combined)) {
    return { category: 'support', priority: 'P1', sentiment: 'frustrated', entities: {}, confidence: 0.6, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
  }

  // Sales keywords
  if (/pricing|quote|proposal|interested|buy|purchase|demo|sales|partnership/i.test(combined)) {
    return { category: 'sales', priority: 'P1', sentiment: 'positive', entities: {}, confidence: 0.6, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
  }

  // Spam indicators
  if (/unsubscribe|offer|discount|limited time|act now|winner|congratulations|viagra|casino/i.test(combined)) {
    return { category: 'spam', priority: 'P3', sentiment: 'neutral', entities: {}, confidence: 0.7, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
  }

  // Newsletter patterns
  if (/newsletter|digest|weekly|monthly|update from|this week in/i.test(subject)) {
    return { category: 'newsletter', priority: 'P3', sentiment: 'neutral', entities: {}, confidence: 0.6, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
  }

  // Default
  return { category: 'other', priority: 'P2', sentiment: 'neutral', entities: {}, confidence: 0.5, raw_response: 'fallback', llm_model: 'keyword-fallback', llm_cost_usd: 0 };
}
