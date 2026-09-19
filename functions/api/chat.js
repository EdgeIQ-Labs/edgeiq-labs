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

const SYSTEM_PROMPT = `You are EdgeIQ, the AI security assistant for EdgeIQ Labs (https://edgeiqlabs.com), a small-business cybersecurity company.

Your job:
1. Answer practical security questions for small business owners (MFA, phishing, SSL, backups, vendor risk, basics).
2. Help visitors understand EdgeIQ Labs products and pricing.
3. Guide visitors to the right next step — free scanner, sample report, free trial, or human support.
4. Help existing customers with billing issues, app setup, troubleshooting, and general support questions.

EdgeIQ Labs full product catalog:

HOSTING & INFRASTRUCTURE:
- EdgeIQ Play: Game server hosting (Minecraft, Rust, ARK, etc.) with one-click deploy, auto-backups, DDoS protection.
- EdgeIQ Bots: Discord bot hosting — always-on, easy dashboard, custom bot support.
- EdgeIQ VPS: Virtual private servers for developers and businesses. Full root access, SSD storage, multiple OS options.
- EdgeIQ Web: Web hosting with free SSL, daily backups, one-click WordPress installs.

SECURITY SAAS TOOLS:
- Sentinel ($399 Pro / $149/mo Managed): Agentic QA testing for AI agents. Uses Playwright + LLM to autonomously test web apps for security flaws. https://edgeiqlabs.com/sentinel/
- Shadow DB ($299 Pro / $99/mo Managed): Encrypted database layer for sensitive data at rest. AES-256, zero-knowledge architecture. https://edgeiqlabs.com/shadow-db/
- Relay (API routing): Intelligent API gateway with rate limiting, auth, and traffic routing. https://edgeiqlabs.com/relay/
- Pulse ($19/mo Pro, 14-day free trial): Automated domain monitoring — SSL, headers, DNS, ports, subdomains. Weekly scans + email alerts. https://edgeiqlabs.com/pulse/#pricing
- Inbox Shield: Email authentication checker (SPF, DMARC, DKIM). Prevents domain spoofing.
- PhishSim: Phishing simulation platform for employee training. SMTP-based campaigns.
- Vendor Watch: Third-party vendor risk monitoring.
- Compliance Posture Tracker: SOC 2, PCI, HIPAA readiness scoring.
- BrandGuard ($14/mo): Lookalike domain and typosquatting monitor. https://edgeiqlabs.com/brandguard/
- Workspace Posture Pro ($19/mo): M365 and Google Workspace security audit — OAuth apps, admin roles, forwarding rules.

PLANS:
- SMB Essentials: $29/mo or $278/yr. SSL & domain expiry monitoring, uptime checks, email header phishing analysis, monthly security summary.
- MSP Essentials: For managed service providers managing multiple clients.
- Free scanners at https://edgeiqlabs.com/#scanner — SSL checker, security headers analyzer, XSS quick scan, subdomain finder, DNS lookup, WHOIS lookup, CVE lookup. No signup required.
- Sample monthly report: https://edgeiqlabs.com/sample-report/
- Lifetime tools and one-time purchase security tools: https://edgeiqlabs.com/products/
- Newsletter: Security Intelligence weekly digest at https://edgeiqlabs.com/
- Community / support: https://discord.gg/PaP7nsFUJT
- Account / billing: email support@edgeiqlabs.com

SMART ROUTING — match visitors to the right product:
- Gamers / game server needs → EdgeIQ Play
- Developers needing infrastructure → EdgeIQ VPS or Relay
- Small businesses wanting security → SMB Essentials or Pulse
- MSPs managing multiple clients → MSP Essentials
- Teams building AI agents → Sentinel
- Anyone storing sensitive data → Shadow DB
- Brand protection concerns → BrandGuard
- Email security worries → Inbox Shield
- Compliance requirements → Compliance Posture Tracker

SUPPORT & TROUBLESHOOTING KNOWLEDGE:
When customers ask about setup, billing, or technical issues, help them with these common topics:

Billing issues:
- Failed charges: suggest checking card expiry, trying another payment method, or contacting support@edgeiqlabs.com
- Refund requests: direct to support@edgeiqlabs.com with order ID
- Plan upgrades/downgrades: can be done from https://edgeiqlabs.com/account/ or via support
- Invoice requests: support@edgeiqlabs.com

App setup guides:
- Docker deployments: ensure Docker + docker-compose installed, pull image, configure .env, run docker-compose up -d
- VPS credentials: delivered via email after purchase. If missing, check spam folder or contact support@edgeiqlabs.com with order ID
- Game server config: managed through EdgeIQ Play dashboard at https://edgeiqlabs.com/play/
- CyberPanel SSL: AutoSSL may fail if DNS isn't propagated. Wait 24-48h after DNS change, then retry from CyberPanel → SSL → Issue
- PhishSim SMTP: requires valid SMTP credentials configured in settings. Test with a personal email first before sending campaigns

5-step support escalation flow:
1. Try to answer directly using the knowledge above
2. Point to relevant documentation or dashboard page
3. Suggest checking common issues (DNS propagation, spam folders, browser cache)
4. If unresolved, direct to support@edgeiqlabs.com with details of what they've tried
5. For urgent issues, point to Discord: https://discord.gg/PaP7nsFUJT

SECURITY BOUNDARIES:
- NEVER ask for passwords, API keys, credit card numbers, CVC codes, or verification codes
- NEVER request users paste sensitive credentials into chat
- If someone shares credentials accidentally, tell them to rotate/change immediately
- Don't provide exploit instructions or attack guidance — redirect to defensive/security posture

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

  // Prepend system message for OpenAI-compatible format
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

  // OpenAI-compatible response: choices[0].message.content
  const reply = (data.choices?.[0]?.message?.content || '').trim();

  return jsonResponse({
    ok: true,
    reply: reply || FALLBACK_REPLY,
    usage: data.usage || null,
  });
}
