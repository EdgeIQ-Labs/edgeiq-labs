# Vendor Risk Assessment — Product Specification

**Product:** EdgeIQ Labs Vendor Risk Assessment  
**Status:** Scaffold / Pre-Launch  
**Target Audience:** Small healthcare practices, SMBs with HIPAA/PCI obligations  
**Owner:** Product Team  
**Last Updated:** 2026-11-01

---

## Overview

Vendor Risk Assessment is a HIPAA-native vendor management platform that helps small healthcare practices and SMBs track, assess, and monitor third-party vendors without the $10K+ enterprise compliance bundle. It integrates natively with Compliance Shield (continuous HIPAA monitoring) and PhishSim (staff phishing resilience) to provide cross-product intelligence no standalone vendor tool offers.

### Key Differentiators

- **HIPAA-Native by Design**: BAA tracking, subcontractor verification, and PHI handling classification built in — not bolted on
- **Standalone Pricing**: $499–$999/mo vs. $10K+ for UpGuard/Vanta enterprise bundles
- **Cross-Product Intelligence**: Vendor risk scores automatically factor in your Compliance Shield audit results and PhishSim staff training completion rates
- **AI Auto-Fill from Public Evidence**: Pull SOC2 reports, HITRUST certifications, and public breach history to pre-populate assessments
- **Transparent Self-Serve**: No sales calls, no custom quotes for standard tiers, email-only support

---

## Features

### Core Assessment Workflow

1. **Vendor Onboarding**: Add vendors via name/domain; AI pulls public evidence (SOC2, HITRUST, breach history, privacy policy)
2. **Risk Questionnaire**: Customizable templates (HIPAA, PCI, general) with conditional logic
3. **AI Auto-Fill**: Pre-populate answers from vendor's public documentation + your historical assessments
4. **Evidence Collection**: Upload BAAs, SOC2 reports, insurance certificates; OCR extracts key dates/clauses
5. **Risk Scoring**: Automated scoring based on responses, evidence gaps, and cross-product signals
6. **Continuous Monitoring**: Quarterly re-assessment triggers, expiry alerts for BAAs/certifications

### HIPAA-Specific Capabilities

- **BAA Lifecycle Tracking**: Expiry alerts, missing clause detection, subcontractor BAA chaining
- **PHI Handling Classification**: Tag vendors by PHI access level (full, limited, none) with automatic control mapping
- **Audit Readiness Reports**: One-click export of vendor inventory + assessment status for OCR audits
- **Subcontractor Verification**: Automatically flag when a vendor uses subcontractors requiring downstream BAAs

### Cross-Product Integration

| Source Product | Signal | Vendor Risk Impact |
|----------------|--------|--------------------|
| Compliance Shield | Failed HIPAA control (e.g., unencrypted laptop) | Auto-downgrade vendor score if they handle same data type |
| PhishSim | Staff phishing failure rate >15% | Flag vendors with high PHI access for additional review |
| Repo Scanner | Leaked secrets in vendor's public repos | Critical risk flag, auto-trigger reassessment |
| ShieldFill | Historical questionnaire answers | Reuse verified responses across vendor assessments |

### AI Auto-Fill Sources

- Vendor website privacy/security pages
- Public SOC2/HITRUST/ISO certification registries
- HHS breach portal (OCR breach database)
- Your organization's past assessments (learning from prior reviews)
- Industry benchmarks (anonymized aggregate data)

---

## Pricing Tiers

| Feature | Starter ($499/mo) | Professional ($999/mo) | Enterprise (Custom) |
|---------|-------------------|------------------------|---------------------|
| Vendors tracked | ≤15 | ≤50 | Unlimited |
| Assessments/month | 10 | Unlimited | Unlimited |
| AI auto-fill | ✓ | ✓ | ✓ |
| BAA tracking | ✓ | ✓ | ✓ |
| Continuous monitoring | Quarterly | Monthly | Real-time |
| Cross-product signals | Basic | Full | Full + custom rules |
| Audit-ready exports | PDF | PDF + CSV + API | All + white-label |
| Support | Email (48h SLA) | Email (24h SLA) | Dedicated CSM |
| SSO/SAML | ✗ | ✓ | ✓ |
| Custom integrations | ✗ | ✗ | ✓ |

**Payment Links (Placeholder):**
- Starter: `https://buy.stripe.com/placeholder-vendor-starter`
- Professional: `https://buy.stripe.com/placeholder-vendor-pro`
- Enterprise: `mailto:compliance@edgeiqlabs.com?subject=Vendor%20Risk%20Enterprise`

---

## Integration Points

### Compliance Shield

- Shared vendor inventory (bidirectional sync)
- HIPAA control failures auto-create vendor risk flags
- Combined audit report: internal controls + vendor posture in single export

### PhishSim

- Staff training completion rates feed vendor risk scoring
- High-risk vendors trigger targeted phishing simulations for staff who interact with them
- Unified dashboard: human risk + vendor risk side-by-side

### ShieldFill

- Reuse questionnaire answers between inbound (ShieldFill) and outbound (Vendor Risk) assessments
- Knowledge base sync: verified answers propagate across products

### Repo Scanner

- Monitor vendor GitHub/GitLab orgs for leaked secrets
- Automatic risk escalation on detection

---

## Competitive Positioning

| Capability | EdgeIQ Vendor Risk | UpGuard | Vanta | SecurityScorecard |
|------------|-------------------|---------|-------|-------------------|
| HIPAA BAA tracking | Native | Add-on | Add-on | Limited |
| Standalone pricing | $499/mo | $10K+/yr | $10K+/yr | $15K+/yr |
| Cross-product signals | ✓ (Compliance Shield + PhishSim) | ✗ | ✗ | ✗ |
| AI auto-fill from public evidence | ✓ | Partial | ✗ | ✓ |
| Self-serve onboarding | ✓ | Sales-gated | Sales-gated | Sales-gated |
| Small practice focus | ✓ | Enterprise-first | Mid-market | Enterprise-first |
| Email-only support | ✓ | Phone/Slack | Phone/Slack | Phone/Slack |

---

## Technical Notes

- Data residency: US-only hosting (HIPAA requirement)
- Encryption: AES-256 at rest, TLS 1.3 in transit
- BAA: Available for all paid tiers
- Retention: 7-year default (HIPAA audit window), configurable
- API: RESTful, documented at `/docs/api/vendor-risk/` (future)

---

## Open Questions

- [ ] Stripe product IDs pending creation
- [ ] Legal review of BAA template for vendor module
- [ ] Confirm HHS breach portal scraping ToS compliance
- [ ] Design review: comparison table mobile layout
