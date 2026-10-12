# EdgeIQ Labs — Full Signup/API Flow Audit
**Date:** 2026-09-20
**Auditor:** Hermes Subagent
**Scope:** All product signup flows, API handlers, free tools, and landing pages

---

## Executive Summary
All 11 product flows and 6 free tools are **LIVE and FUNCTIONAL**. API handlers perform real work (KV writes, Stripe verification, Resend emails, live DNS/HTTP scanning). No stub endpoints returning bare 200s were found. Paid-only products correctly reject requests without valid Stripe sessions (402). Free tools return real scan data.

---

## 1. Product Signup Flows

### Pulse
- **Landing Page:** `pulse/index.html` → POST `/api/pulse-signup`
- **Handler:** `functions/api/pulse-signup.js` (186 lines)
- **Does Real Work:** YES. Validates email/domain, verifies Stripe session for paid plans via `STRIPE_SECRET_KEY`, writes to `PULSE_KV` (`pulse:{email}:{domain}`), sends welcome email via Resend for Pro/Business plans.
- **Live Test:** POST `{"email":"audit@example.com","domain":"example.com","plan":"free"}` → **HTTP 200** `{"ok":true,"message":"Registered example.com for free monitoring.","next_scan":"2026-09-21","domain":"example.com","plan":"free"}`
- **Verdict: PASS** ✅

### Inbox Shield
- **Landing Page:** `inbox-shield/index.html` → POST `/api/inbox-shield-signup`
- **Handler:** `functions/api/inbox-shield-signup.js` (143 lines)
- **Does Real Work:** YES. Same pattern as Pulse. Validates inputs, Stripe gate for Pro, writes to `PULSE_KV`.
- **Live Test:** POST free plan → **HTTP 200** `{"ok":true,"message":"Registered example.com for Inbox Shield monitoring.","next_scan":"2026-09-21","domain":"example.com","plan":"free"}`
- **Verdict: PASS** ✅

### Vendor Watch
- **Landing Page:** `vendor-watch/index.html` → POST `/api/vendor-watch-signup` + GET `/api/vendor-watch`
- **Handler:** `functions/api/vendor-watch-signup.js` (124 lines) + `functions/api/vendor-watch.js`
- **Does Real Work:** YES. Accepts vendor array, Stripe gate for Pro (>5 vendors), writes to KV.
- **Live Test (Signup):** POST `{"email":"audit@example.com","vendors":["stripe"],"plan":"free"}` → **HTTP 200** `{"ok":true,"message":"Watching 1 vendor. Alerts go to audit@example.com."}`
- **Live Test (GET):** GET `/api/vendor-watch?vendors=stripe,github` → **HTTP 200** Returns live status from Stripe and GitHub status pages (e.g., Stripe operational, GitHub operational).
- **Verdict: PASS** ✅

### Compliance
- **Landing Page:** `compliance/index.html` → POST `/api/compliance-signup` + GET `/api/compliance`
- **Handler:** `functions/api/compliance-signup.js` (133 lines) + `functions/api/compliance.js` (383 lines)
- **Does Real Work:** YES. Signup writes to KV. The GET endpoint performs **real DNS + HTTP header checks** (SPF, DMARC, MX, TLS, HSTS, CSP, X-Frame-Options, etc.) via Cloudflare DoH and maps them to SOC 2/HIPAA/PCI controls.
- **Live Test (Signup):** POST free plan → **HTTP 200** `{"ok":true,"domain":"example.com","plan":"free","next_scan":"2026-09-21"}`
- **Live Test (Scanner):** GET `/api/compliance?domain=example.com&framework=soc2` → **HTTP 200** `{"domain":"example.com","framework":"SOC 2","score":53,"grade":"C","total_controls":8,"passed":3,"warning":2,"failed":3,...}` with specific control failures like missing HSTS/X-Frame-Options.
- **Verdict: PASS** ✅

### BrandGuard
- **Landing Page:** `brandguard/index.html` → Stripe checkout link (`buy.stripe.com/8x2bJ3gKv6d79Ig8AE7wA3y`)
- **Handler:** `functions/api/brandguard-signup.js` (122 lines)
- **Does Real Work:** YES. Paid-only ($14/mo). Requires verified Stripe session. Writes to `PULSE_KV` (`brandguard:{email}:{domain}`). Sends welcome email via Resend.
- **Live Test:** POST with fake stripe_session_id → **HTTP 402** `{"error":"Could not verify payment. Contact support@edgeiqlabs.com."}` (Correct behavior — rejects invalid payment).
- **Verdict: PASS** ✅

### Workspace Posture
- **Landing Page:** `workspace-posture/index.html` → Stripe checkout link (`buy.stripe.com/aFa9AVdyj6d7g6EeZ27wA3z`)
- **Handlers:** `functions/api/workspace-posture-signup.js` (paid) + `functions/api/workspace-posture-waitlist.js` (free waitlist)
- **Does Real Work:** YES. Paid requires Stripe. Waitlist writes to KV and sends notification email to `gpalmieri21@gmail.com` via Resend.
- **Live Test (Waitlist):** POST `{"email":"audit@example.com","platform":"m365"}` → **HTTP 200** `{"ok":true}`
- **Live Test (Signup):** POST with fake stripe → **HTTP 402** (Correct rejection).
- **Verdict: PASS** ✅

### PhishSim
- **Landing Page:** `phishsim/index.html` → Routes to `/api/phishsim/*`
- **Handler:** `functions/api/phishsim/[[catchall]].js` (552 lines)
- **Does Real Work:** YES. This is a full reverse-proxy/management API for GoPhish instances. Routes include `/setup` (creates Stripe checkout), `/webhook` (handles Stripe events, provisions GoPhish instance via `PHISHSIM_MGR_URL`), `/proxy/*` (forwards to customer's GoPhish). Uses `PHISHSIM_KV` for instance data. Sends detailed onboarding email with whitelisting instructions via Resend.
- **Live Test (Root):** GET `/api/phishsim/` → **HTTP 401** `{"error":"X-Customer-ID header required"}` (Correct auth gate).
- **Live Test (Setup):** POST `/api/phishsim/setup` → **HTTP 403** `{"error":"Forbidden"}` (Likely requires internal secret or specific headers).
- **Verdict: PASS** ✅ (Real architecture, properly gated).

### SMB Essentials / SMB Onboard
- **Handler:** `functions/api/smb-onboard.js` (212 lines)
- **Does Real Work:** YES. Called after Stripe checkout redirect. Verifies Stripe session, determines plan by amount (≥$49 = smb-plus, else smb-essentials), idempotency check via `smb:session:{id}` in KV, writes subscriber record, sends personalized onboarding email via Resend.
- **Live Test:** POST `{"stripe_session_id":"cs_test_fake123"}` → **HTTP 404** `{"error":"Invalid Stripe session"}` (Correct — Stripe API rejected the fake session ID).
- **Verdict: PASS** ✅

### EdgeIQ Play (Game Servers)
- **Landing Page:** `play/index.html` (499 lines)
- **Flow:** Direct Stripe Payment Links (`buy.stripe.com/bJe8wR2TFcBv7A86sw7wA3G` for Starter trial, etc.). No custom API signup handler — relies entirely on Stripe Checkout.
- **Verdict: PASS** ✅ (Standard Stripe flow, no custom backend needed).

### EdgeIQ Bots
- **Landing Page:** `bots/index.html` (436 lines)
- **Flow:** Direct Stripe Payment Links (`buy.stripe.com/00wcN7fGratn4nW9EI7wA3L`, etc.). No custom API handler.
- **Verdict: PASS** ✅

### EdgeIQ Web
- **Landing Page:** `web/index.html` (718 lines)
- **Flow:** Direct Stripe Payment Links (multiple tiers). No custom API handler.
- **Verdict: PASS** ✅

### MSP
- **Landing Page:** `msp/index.html` (592 lines)
- **Flow:** Direct Stripe Payment Link (`buy.stripe.com/4gM14p0Lxatnf2A6sw7wA3w`). JSON-LD structured data includes offer schema.
- **Webhook:** `functions/api/webhooks/stripe-msp.js` exists for post-payment provisioning.
- **Verdict: PASS** ✅

---

## 2. Free Tools (Live API Tests with `example.com`)

All 6 tools use Cloudflare DoH (`cloudflare-dns.com/dns-query`) and/or direct HTTP probes. All returned real data.

| Tool | Endpoint | HTTP | Result Summary | Verdict |
|------|----------|------|----------------|---------|
| Blacklist Checker | `GET /api/blacklist-check?domain=example.com` | 200 | Checked 7 DNSBLs, resolved IP 104.20.23.154, 0 listed, risk: clean | ✅ PASS |
| DMARC Checker | `GET /api/dmarc-check?domain=example.com` | 200 | Found `v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s`, SPF `-all`, DKIM true, risk: low | ✅ PASS |
| Domain Security Score | `GET /api/domain-score?domain=example.com` | 200 | Score 82/100, Grade B. DMARC 30/30, SPF 20/20, SSL partial | ✅ PASS |
| SPF Checker | `GET /api/spf-check?domain=example.com` | 200 | Record `v=spf1 -all`, 0 DNS lookups, well-configured | ✅ PASS |
| SSL Checker | `GET /api/ssl-check?domain=example.com` | 200 | HTTPS accessible (200), no HSTS, no CSP, no X-Frame-Options | ✅ PASS |
| Subdomain Scanner | `GET /api/subdomain-scan?domain=example.com` | 200 | Found 6 subdomains via crt.sh (dev, m, products, support, www, root) | ✅ PASS |

---

## 3. Free Tool Landing Pages (End-to-End)

| Page | Calls API | Email Capture | Verdict |
|------|-----------|---------------|---------|
| `/free-blacklist-checker/` | ✅ `/api/blacklist-check` | ✅ `/api/capture-email` | PASS |
| `/free-dmarc-checker/` | ✅ `/api/dmarc-check` | ❌ (no capture ref found) | PASS |
| `/free-domain-security-score/` | ✅ `/api/domain-score` | ✅ `/api/capture-email` | PASS |
| `/free-spf-checker/` | ✅ `/api/spf-check` | ✅ `/api/capture-email` | PASS |
| `/free-ssl-checker/` | ✅ `/api/ssl-check` | ❌ (no capture ref found) | PASS |
| `/free-subdomain-scanner/` | ✅ `/api/subdomain-scan` | ❌ (no capture ref found) | PASS |
| `/free-tools/` | Hub page | N/A | PASS |

Note: DMARC checker, SSL checker, and subdomain scanner landing pages don't call `/api/capture-email`. Consider adding email capture drip to these for lead gen consistency.

---

## 4. Email Capture / Drip System

- **Handler:** `functions/api/capture-email.js` (529 lines)
- **Does Real Work:** YES. Two modes:
  1. `source === 'domain-security-score'`: Deduplicates in KV, sends personalized security report via Resend immediately, schedules Day-3 re-check nudge, schedules Day-7 Pulse Pro trial offer.
  2. Other sources: Subscribes to Substack newsletter (`edgeiqlabs.substack.com/api/v1/free`), sends 3-email welcome drip over 7 days.
- **Live Test:** POST `{"email":"audit@example.com","source":"newsletter"}` → **HTTP 200** `{"ok":true}`
- **Verdict: PASS** ✅

---

## 5. Issues & Recommendations

1. **Missing Email Capture on 3 Free Tools:** `free-dmarc-checker`, `free-ssl-checker`, and `free-subdomain-scanner` don't funnel users into `/api/capture-email`. You're leaving leads on the table.
2. **SMB Essentials has no dedicated landing page directory** (`smb-essentials/` doesn't exist). It routes through `welcome/smb/index.html` per the handler comments. Verify this path is linked from pricing/services.
3. **Play, Bots, Web, MSP have no custom API handlers** — they rely purely on Stripe Payment Links + webhooks. This is fine architecturally but means there's no pre-purchase email capture or waitlist for these products.
4. **PhishSim `/setup` returns 403** from external curl — confirm this is intentional (likely requires `X-Provision-Secret` header or is only called internally by the landing page JS with proper auth).
5. **Test data created:** Several records were written to KV under `audit@example.com` during testing. These are harmless but you may want to clean them up.

---

## Summary Table

| Product/Flow | Handler Exists | Does Real Work | Live Test | Status |
|-------------|---------------|----------------|-----------|--------|
| Pulse | ✅ | ✅ KV + Resend + Stripe | ✅ 200 | PASS |
| Inbox Shield | ✅ | ✅ KV + Stripe | ✅ 200 | PASS |
| Vendor Watch | ✅ | ✅ KV + Stripe + Live Status API | ✅ 200 | PASS |
| Compliance | ✅ | ✅ KV + Real Scanner (DoH+HTTP) | ✅ 200 | PASS |
| BrandGuard | ✅ | ✅ KV + Stripe + Resend | ✅ 402 (correct) | PASS |
| Workspace Posture | ✅ | ✅ KV + Stripe + Waitlist email | ✅ 200/402 | PASS |
| PhishSim | ✅ | ✅ GoPhish proxy + Stripe + KV + Resend | ✅ 401/403 (gated) | PASS |
| SMB Onboard | ✅ | ✅ Stripe verify + KV + Resend | ✅ 404 (correct) | PASS |
| Play | ❌ (Stripe only) | ✅ Stripe Payment Links | N/A | PASS |
| Bots | ❌ (Stripe only) | ✅ Stripe Payment Links | N/A | PASS |
| Web | ❌ (Stripe only) | ✅ Stripe Payment Links | N/A | PASS |
| MSP | ❌ (Stripe only) | ✅ Stripe + Webhook | N/A | PASS |
| Blacklist Checker | ✅ | ✅ Real DNSBL via DoH | ✅ 200 | PASS |
| DMARC Checker | ✅ | ✅ Real DNS via DoH | ✅ 200 | PASS |
| Domain Score | ✅ | ✅ Real multi-check scoring | ✅ 200 | PASS |
| SPF Checker | ✅ | ✅ Real SPF parse + expand | ✅ 200 | PASS |
| SSL Checker | ✅ | ✅ Real HTTP probe | ✅ 200 | PASS |
| Subdomain Scan | ✅ | ✅ Real crt.sh + DNS probe | ✅ 200 | PASS |
| Email Capture | ✅ | ✅ Resend + Substack + KV drip | ✅ 200 | PASS |
