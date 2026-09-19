// Cloudflare Pages Function: POST /api/chat
// Calls Dialagram (OpenAI-compatible, qwen-3.8-max) and returns the assistant's reply.
//
// Required env var (set in Cloudflare → Pages → edgeiq-labs → Settings →
// Environment variables): DIALAGRAM_API_KEY
//
// Returns JSON. On any failure, returns a `service_unavailable` shape that
// the front-end widget renders as a graceful fallback.

const DIALAGRAM_URL = 'https://dialagram.me/router/v1/chat/completions';
const MODEL = 'qwen-3.8-max';
const MAX_USER_MSG_CHARS = 1500;
const MAX_HISTORY_MESSAGES = 20;

const SYSTEM_PROMPT = `You are EdgeIQ, the AI security assistant for EdgeIQ Labs (https://edgeiqlabs.com), a cybersecurity company building tools for developers, indie hackers, and small teams.

Your job:
1. Answer practical security questions (MFA, phishing, SSL, backups, vendor risk, API security, encryption basics).
2. Help visitors understand EdgeIQ Labs products and pricing.
3. Guide visitors to the right next step — product page, free scanner, or human support.

EdgeIQ Labs products (use these accurately, never invent details not listed):

- Sentinel ($399 Pro / $149/mo Managed): Agentic QA tool. Uses Playwright and an LLM loop to watch AI agents work, catch them breaking things, and execute fixes. Not stale assertions — actual visual verification via ariaSnapshot analysis. Open source core on GitHub. Landing page: https://edgeiqlabs.com/sentinel/

- Shadow DB ($299 Pro / $99/mo Managed): Encrypted database layer. Transparent field-level encryption for PostgreSQL and MySQL. Automatic key rotation, audit logging. For teams handling sensitive data without a dedicated security engineer. Landing page: https://edgeiqlabs.com/shadow-db/

- Relay (see site for plans): API routing infrastructure. Centralized auth, rate limiting, request transformation across services. Stops you from rewriting routing every time you add a microservice. Landing page: https://edgeiqlabs.com/relay/

- Free scanner tools at https://edgeiqlabs.com/#scanner — SSL checker, security headers analyzer, XSS quick scan, subdomain finder, DNS lookup, WHOIS lookup, CVE lookup. No signup required.

- Blog with security guides and product deep-dives: https://edgeiqlabs.com/blog/

- Community / support: https://discord.gg/PaP7nsFUJT
- Account / billing questions: email support@edgeiqlabs.com.

Style:
- Concise. 2–4 sentences per reply by default; expand only if the user asks for detail.
- Practical and direct — explain to a developer or small team lead, not an enterprise CISO.
- When suggesting a product or action, include the relevant edgeiqlabs.com link.
- You cannot browse the web. If a user asks "is my site secure?" or anything domain-specific, tell them to run the free scanner at https://edgeiqlabs.com/#scanner.
- Never invent prices, features, guarantees, or compliance claims not in this prompt.
- If a question is outside cybersecurity or EdgeIQ Labs, politely redirect.

Privacy:
- Conversations are not stored on the server. Each request is independent.
- Never ask for passwords, credit card numbers, API keys, or other sensitive data.

If you don't know something specific, say so plainly and point to Discord or email for follow-up — don't guess.`;

const FALLBACK_REPLY =
  "Chat is temporarily unavailable. You can still email support@edgeiqlabs.com or join our Discord at https://discord.gg/PaP7nsFUJT — or run the free scanner at /#scanner.";

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Validate config
  if (!env.DIALAGRAM_API_KEY) {
    return jsonResponse({
      ok: false,
      error: 'service_not_configured',
      reply: FALLBACK_REPLY,
    });
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid_json', reply: FALLBACK_REPLY }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return jsonResponse({ ok: false, error: 'no_messages', reply: 'Send a message to start.' }, 400);
  }

  // Length / shape sanity
  const trimmed = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_USER_MSG_CHARS),
    }));

  if (trimmed.length === 0 || trimmed[trimmed.length - 1].role !== 'user') {
    return jsonResponse({ ok: false, error: 'last_must_be_user', reply: FALLBACK_REPLY }, 400);
  }

  // Build OpenAI-compatible payload with system message first
  const apiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimmed,
  ];

  // Call Dialagram (OpenAI-compatible)
  let upstream;
  try {
    upstream = await fetch(DIALAGRAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DIALAGRAM_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        messages: apiMessages,
      }),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'upstream_unreachable', reply: FALLBACK_REPLY });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'upstream_invalid', reply: FALLBACK_REPLY });
  }

  if (!upstream.ok || data.error) {
    return jsonResponse({
      ok: false,
      error: 'upstream_error',
      reply: FALLBACK_REPLY,
      _debug: { type: data.error?.type || 'unknown', message: data.error?.message || '' },
    });
  }

  // Extract reply from OpenAI format
  const reply = (data.choices || [])
    .map((c) => c.message?.content || '')
    .join('\n')
    .trim();

  return jsonResponse({
    ok: true,
    reply: reply || FALLBACK_REPLY,
    usage: data.usage || null,
  });
}
