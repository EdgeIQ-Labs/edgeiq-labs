// Cloudflare Pages Function: POST /api/chat
// Calls Anthropic Claude Haiku and returns the assistant's reply.
//
// Required env var (set in Cloudflare → Pages → edgeiq-labs → Settings →
// Environment variables): ANTHROPIC_API_KEY = sk-ant-api03-...
//
// Returns JSON. On any failure, returns a `service_unavailable` shape that
// the front-end widget renders as a graceful fallback.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_USER_MSG_CHARS = 1500;
const MAX_HISTORY_MESSAGES = 20;

const SYSTEM_PROMPT = `You are EdgeIQ, the AI security assistant for EdgeIQ Labs (https://edgeiqlabs.com), a small-business cybersecurity company.

Your job:
1. Answer practical security questions for small business owners (MFA, phishing, SSL, backups, vendor risk, basics).
2. Help visitors understand EdgeIQ Labs products and pricing.
3. Guide visitors to the right next step — free scanner, sample report, free trial, or human support.

EdgeIQ Labs facts (use these accurately, never invent details not listed):
- Free scanner tools at https://edgeiqlabs.com/#scanner — SSL checker, security headers analyzer, XSS quick scan, subdomain finder, DNS lookup, WHOIS lookup, CVE lookup. No signup required.
- SMB Essentials: $29/mo or $278/yr. Includes SSL & domain expiry monitoring, uptime checks, email header phishing analysis, monthly security summary report.
- SMB Plus: $49/mo or $470/yr. Everything in Essentials plus priority remediation support, expanded monthly report + action plan, higher-touch help on urgent findings.
- 14-day free trial on all SMB plans, no card charged until day 15.
- Sample monthly report: https://edgeiqlabs.com/sample-report/ — shows exactly what customers receive each month.
- Lifetime tools (XSS Scanner Pro, Network Scanner Pro, etc.) and one-time tools for security pros and developers: https://edgeiqlabs.com/products/
- Newsletter: https://edgeiqlabs.substack.com — weekly practical security tips.
- Community / support: https://discord.gg/PaP7nsFUJT
- Account / billing questions: email support@edgeiqlabs.com.

Style:
- Concise. 2–4 sentences per reply by default; expand only if the user asks for detail.
- Practical and business-focused — explain to a small business owner, not a security pro.
- When suggesting an action, include the relevant edgeiqlabs.com link.
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
  if (!env.ANTHROPIC_API_KEY) {
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

  // Call Anthropic
  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: trimmed,
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
    // Map common Anthropic errors to a single graceful state for the UI.
    // (We don't surface internals like "credit balance too low" to users.)
    return jsonResponse({
      ok: false,
      error: 'upstream_error',
      reply: FALLBACK_REPLY,
      // Keep the upstream message in the response for operator debugging
      // via DevTools — but the widget displays only `reply`.
      _debug: { type: data.error?.type || 'unknown', message: data.error?.message || '' },
    });
  }

  const reply = (data.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();

  return jsonResponse({
    ok: true,
    reply: reply || FALLBACK_REPLY,
    usage: data.usage || null,
  });
}
