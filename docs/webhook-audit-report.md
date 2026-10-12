# EdgeIQ Labs Webhook Audit Report
**Date:** 2026-09-20
**Scope:** All Stripe webhook endpoints registered to edgeiqlabs.com + related provisioning flows

---

## 1. Core Pages Functions Webhooks

### stripe-msp.js — **PASS (with warnings)**
- **Live test:** 401 no-sig, 401 bad-sig ✅ (code is running and rejecting)
- **Stripe endpoint:** `we_1TYZZFRC1NZ20yDTh9dz9bUz` → enabled ✅
- **Env vars:** STRIPE_MSP_WEBHOOK_SECRET ✅, RESEND_API_KEY ✅, FROM_EMAIL ⚠️ (missing, falls back to default), SITE_URL ⚠️ (missing, falls back to default)
- **PULSE_KV binding:** present ✅
- **KV write:** `env.PULSE_KV.put('msp:${email}', JSON.stringify(record))` ✅
- **Sig verification:** Uses `crypto.subtle.verify` with hex decoding ✅ (correct approach)
- **Issues:** Missing FROM_EMAIL/SITE_URL env vars (non-breaking due to hardcoded defaults). No idempotency guard — duplicate Stripe deliveries will re-send welcome emails.

### stripe-compliance.js — **FAIL (critical crypto bug)**
- **Live test:** 401 no-sig, 401 bad-sig ✅ (endpoint responds)
- **Stripe endpoint:** `we_1TYrXWRC1NZ20yDTkLiohkfx` → enabled ✅
- **Env vars:** STRIPE_COMPLIANCE_WEBHOOK_SECRET ✅, RESEND_API_KEY ✅, FROM_EMAIL ⚠️, SITE_URL ⚠️
- **PULSE_KV binding:** present ✅
- **KV write:** `env.PULSE_KV.put('compliance:${email}:${domain}', ..., {metadata: ...})` ✅
- **CRITICAL BUG:** Signature verification uses `crypto.subtle.sign` instead of `verify`. It computes an HMAC locally and compares hex strings. This works functionally but:
  - Key imported with `['sign']` usage instead of `['verify']`
  - String comparison (`computed === parts.v1`) is timing-attack vulnerable
  - Inconsistent with MSP which correctly uses `crypto.subtle.verify`
- **Status:** FAIL — signature verification is cryptographically unsound (timing attack surface) despite appearing to work in tests.

### stripe-brandguard.js — **FAIL (same critical crypto bug as compliance)**
- **Live test:** 401 no-sig, 401 bad-sig ✅
- **Stripe endpoint:** `we_1TYrXXRC1NZ20yDTeWtwB6k3` → enabled ✅
- **Env vars:** STRIPE_BRANDGUARD_WEBHOOK_SECRET ✅, RESEND_API_KEY ✅, FROM_EMAIL ⚠️, SITE_URL ⚠️
- **PULSE_KV binding:** present ✅
- **KV write:** `env.PULSE_KV.put('brandguard:${email}:${domain}', ..., {metadata: ...})` ✅
- **CRITICAL BUG:** Identical sign-instead-of-verify pattern + string comparison timing vulnerability as compliance.js.
- **Status:** FAIL — same crypto issue.

### stripe-vps.js — **FAIL (multiple critical issues)**
- **Live test:** Returns 405 for ALL requests (no-sig, bad-sig, lowercase header) ❌
- **Stripe endpoint:** `we_1UHR70RC1NZ20yDTm6Cdhj1S` → enabled ✅ (but pointing to dead code)
- **Root cause of 405:** The CF Pages Function at `/api/webhooks/stripe-vps` only exports `onRequestPost` and `onRequestOptions`, but the live endpoint returns 405 Method Not Allowed even for POST. This suggests either a routing conflict, middleware blocking it, or the deployed version differs from source.
- **CRITICAL SECURITY BUG (line 183-188):** Signature comparison is completely broken:
  ```js
  const valid = signatures.some(s => {
    const a = new TextEncoder().encode(s);
    const b = new TextEncoder().encode(expectedSig);
    if (a.length !== b.length) return false;
    return crypto.subtle.timingSafeEqual ? true : (s === expectedSig);
  });
  ```
  `crypto.subtle.timingSafeEqual` does NOT exist in the Web Crypto API. The ternary always evaluates to `true`, meaning **any signature with correct length passes verification**. This is a full authentication bypass.
- **Additional bugs:**
  - Line 12: `const crypto = await import('crypto');` — top-level await import of Node `crypto` module that doesn't exist in CF Workers runtime
  - Uses `crypto.getRandomValues()` (line 53) which would fail if the import above threw
  - If `STRIPE_VPS_WEBHOOK_SECRET` is set but no sig header provided, it correctly rejects (line 205-208)
  - But if `STRIPE_VPS_WEBHOOK_SECRET` is NOT set, signature verification is entirely skipped (line 170 condition)
- **Env vars:** STRIPE_VPS_WEBHOOK_SECRET ✅, STRIPE_SECRET_KEY ✅, PVE_API_TOKEN ✅, RESEND_API_KEY ✅, SITE_URL ⚠️
- **No KV writes:** VPS stores metadata back to Stripe subscription object via API, not KV.
- **Status:** FAIL — endpoint returns 405 (dead), and the signature verification has a complete auth bypass bug.

---

## 2. SMB Onboarding (smb-onboard.js) — **PASS (with notes)**
- **Architecture:** Client-side triggered (welcome page POSTs `stripe_session_id`), NOT a Stripe webhook
- **Live test:** Returns 400 on empty body ✅ (code is running, expects `{stripe_session_id}`)
- **Stripe endpoint:** N/A (not a webhook — client verifies session via Stripe API using `STRIPE_SECRET_KEY`)
- **Env vars:** STRIPE_SECRET_KEY ✅, RESEND_API_KEY ✅
- **PULSE_KV binding:** present ✅
- **KV write:** `env.PULSE_KV.put('smb:session:${sessionId}', ...)` with idempotency check ✅
- **Security:** Validates payment_status via Stripe API server-side before recording. Has idempotency guard.
- **Note:** No dedicated Stripe webhook for SMB bundles — relies on client calling this endpoint after redirect. If user closes browser before redirect completes, they won't be onboarded.
- **Status:** PASS

---

## 3. PhishSim Webhook (/api/phishsim/stripe-webhook) — **PASS (with warnings)**
- **Implementation:** Routed through `functions/api/phishsim/[[catchall]].js` catch-all handler
- **Live test:** Returns 400 on fake payload ✅ (code is running, likely rejecting bad JSON structure or missing fields)
- **Stripe endpoint:** `we_1TX3kbRC1NZ20yDTcIvC6phR` → enabled ✅
- **Env vars:** PHISHSIM_SECRET ✅, PHISHSIM_MGR_URL ✅, PHISHSIM_PRICE_ID ✅, STRIPE_SECRET_KEY ✅, STRIPE_WEBHOOK_SECRET ✅
- **PHISHSIM_KV binding:** present ✅ (namespace cd4fe45e...)
- **Provisioning:** Calls external manager API (`PHISHSIM_MGR_URL/provision`) to create GoPhish instance, saves to PHISHSIM_KV, sends welcome email ✅
- **Security note:** Correctly filters by product — ignores non-PhishSim checkout events (line 403-411) since it receives ALL account webhooks
- **Crypto:** Uses same sign-and-string-compare pattern as compliance/brandguard (timing-vulnerable but functional)
- **Status:** PASS

---

## 4. EdgeIQ Play / Bots / Web Hosting — **FAIL (provisioning code exists but delivery path is broken)**
- **Product IDs searched:** prod_UZTfvmwGSUmL3U, prod_UZTfDl3KC1jdDn, prod_UZTfb7tOA2lGdV (Play), prod_UZoiSvjFWLt6IL, prod_UZoiiQYuwSxsRn, prod_UZoi8hu5znazNK (Bots), prod_UabLfTssHMw90j (Web)
- **Result:** NONE of these product IDs exist anywhere in the repository ❌
- **Where provisioning lives:** `webhook/server.js` — a standalone Express/Docker app (NOT a CF Pages Function)
  - Contains full provisioning logic for game servers (Pterodactyl), bot hosting (Pterodactyl), VPS (Proxmox LXC), web hosting (CyberPanel), WordPress, Sentinel, ShadowDB
  - Maps price IDs (not product IDs) to plans
  - Creates Pterodactyl users/servers for game/bot plans
  - Creates Proxmox LXC containers for VPS plans
  - Creates CyberPanel accounts for web plans
- **Stripe endpoints pointing here:**
  - `we_1UFzYbRC1NZ20yDTM5o8PxRF` → `https://webhook.edgeiqlabs.com/stripe` (live test: POST=400, GET=404)
  - `we_1Tah8MRC1NZ20yDTJIQ6cgi6` → `https://webhook.edgeiqlabs.com/stripe` (duplicate!)
- **Docker status:** Container `edgeiq-webhook` is NOT running on this host (docker ps returned empty) ❌
- **Critical gap:** The `webhook/server.js` provisions everything EXCEPT what the 4 CF Pages webhook functions handle. But the Docker container appears down, meaning Play/Bots/Web/Sentinel/ShadowDB purchases are NOT being provisioned.
- **Status:** FAIL — provisioning code exists but the Docker service is not running. Product IDs referenced in the task don't exist in repo (price IDs are used instead).

---

## 5. Other Registered Stripe Endpoints

### relay.edgeiqlabs.com/webhooks/stripe
- **ID:** `we_1UFdUjRC1NZ20yDTQAvsOYl3` → enabled
- **Events:** invoice.paid, checkout.session.completed
- **Live test:** POST=400, GET=200 ✅ (service is running)
- **Code location:** Referenced in HTML files (bots/index.html, brandguard/index.html, etc.) but implementation not found in this repo — likely separate service
- **Status:** UNKNOWN (alive but code not in this repo)

### api.edgeiqlabs.com/smb-dashboard/webhook
- **ID:** `we_1TT6F6RC1NZ20yDTI0PILC6g` → enabled
- **Live test:** POST=400, GET=404
- **Code:** Not found in this repo
- **Status:** UNKNOWN

### api.edgeiqlabs.com/license
- **ID:** `we_1TQ6AkRC1NZ20yDTkAT4JR5t` → enabled
- **Live test:** POST=400, GET=401
- **Code:** Not found in this repo
- **Status:** UNKNOWN

---

## Summary Table

| Webhook | Endpoint Alive | Stripe Registered | Env Vars | KV Binding | Sig Verify | Provisioning | Status |
|---------|---------------|-------------------|----------|------------|------------|--------------|--------|
| stripe-msp | ✅ 401 | ✅ | ⚠️ 2 missing (defaults ok) | ✅ | ✅ verify() | ✅ KV + email | **PASS** |
| stripe-compliance | ✅ 401 | ✅ | ⚠️ 2 missing | ✅ | ❌ sign+string compare | ✅ KV + email | **FAIL** |
| stripe-brandguard | ✅ 401 | ✅ | ⚠️ 2 missing | ✅ | ❌ sign+string compare | ✅ KV + email | **FAIL** |
| stripe-vps | ❌ 405 | ✅ | ✅ | N/A | ❌ AUTH BYPASS | ❌ Dead endpoint | **FAIL** |
| smb-onboard | ✅ 400 | N/A (client-side) | ✅ | ✅ | N/A (API verify) | ✅ KV + email | **PASS** |
| phishsim-webhook | ✅ 400 | ✅ | ✅ | ✅ | ⚠️ sign+compare | ✅ Mgr API + KV | **PASS** |
| webhook.edgeiqlabs (Play/Bots/Web/VPS) | ⚠️ 400/404 | ✅ (x2!) | N/A (Docker) | N/A | ✅ Stripe SDK | ❌ Container down | **FAIL** |
| relay.edgeiqlabs | ✅ 400/200 | ✅ | Unknown | Unknown | Unknown | Unknown | **UNKNOWN** |
| api.edgeiqlabs/smb-dashboard | ✅ 400/404 | ✅ | Unknown | Unknown | Unknown | Unknown | **UNKNOWN** |
| api.edgeiqlabs/license | ✅ 400/401 | ✅ | Unknown | Unknown | Unknown | Unknown | **UNKNOWN** |

---

## Critical Action Items

1. **stripe-vps.js auth bypass:** The `crypto.subtle.timingSafeEqual` check always returns `true`. Any request with a correctly-lengthed signature passes. Fix immediately or disable the endpoint.
2. **stripe-vps.js 405:** Investigate why the deployed CF Pages Function returns 405 for POST. Possible routing conflict with the Docker webhook server handling the same path.
3. **compliance + brandguard timing attack:** Replace `crypto.subtle.sign` + string comparison with `crypto.subtle.verify` (matching MSP's implementation).
4. **webhook.edgeiqlabs.com Docker container:** The `edgeiq-webhook` container is not running. All Play/Bots/Web/Sentinel/ShadowDB purchases are failing silently. Start the container or migrate to CF Pages Functions.
5. **Duplicate Stripe endpoints:** Two webhook endpoints point to `webhook.edgeiqlabs.com/stripe` (we_1UFzYb and we_1Tah8M). Remove the stale one.
6. **Missing env vars:** Add FROM_EMAIL and SITE_URL to CF Pages production config (currently relying on hardcoded fallbacks).
7. **SMB onboarding reliability:** Client-side triggered onboarding means users who close the tab after payment but before redirect won't be onboarded. Consider adding a Stripe webhook as backup.
