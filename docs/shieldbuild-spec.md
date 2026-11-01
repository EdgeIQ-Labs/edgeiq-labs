# ShieldBuild — OSHA Construction Tracker

**Product:** ShieldBuild by EdgeIQ Labs  
**Tagline:** OSHA Compliance for Construction Crews  
**Status:** Phase 1 (Landing Page + Spec)  
**Last Updated:** 2026-11-01

---

## Product Overview

ShieldBuild is a flat-rate OSHA compliance tracker designed for construction safety managers. It replaces per-user pricing models that punish growing crews with predictable monthly billing tied to company size, not headcount.

Core workflow:
1. **Daily Site Logs** — Foremen log site conditions, crew attendance, and safety observations in under 2 minutes
2. **Inspection Checklists** — Pre-built OSHA-aligned checklists for scaffolding, electrical, excavation, fall protection, and PPE
3. **Incident Reporting** — Structured incident/near-miss reports with photo attachments and root-cause fields
4. **OSHA 300 Log Generation** — Auto-populate the OSHA 300 injury/illness log from incident reports (Phase 2)
5. **Compliance Calendar** — Track training expirations, permit renewals, and inspection deadlines (Phase 2)

## Target Buyer

**Primary:** Construction safety managers at small-to-mid firms (10–200 employees)  
**Secondary:** Healthcare construction project managers (ICRA compliance)  
**Anti-persona:** Enterprise GCs with dedicated EHS departments (they use Cority or Intelex)

### Why This Buyer?
- Safety managers are overwhelmed by paper forms and spreadsheets
- Per-user SaaS pricing ($15–30/user/mo) makes budgeting impossible when crew sizes fluctuate weekly
- Healthcare construction has unique ICRA/HIPAA-adjacent requirements that generic tools ignore
- They need audit-ready documentation, not just data collection

## Pricing Rationale

### Flat-Rate vs Per-User

| Model | SafetyCulture | SiteDocs | Contractor Foreman | ShieldBuild |
|-------|--------------|----------|-------------------|-------------|
| Pricing | $15–30/user/mo | $20/user/mo | $75/user/mo | Flat rate |
| 20-person crew | $300–600/mo | $400/mo | $1,500/mo | $99–299/mo |
| 50-person crew | $750–1,500/mo | $1,000/mo | $3,750/mo | $99–299/mo |
| Budget predictability | ✗ | ✗ | ✗ | ✓ |

The $99–299 range sits in the "dead zone" between consumer apps and enterprise EHS platforms. No competitor offers HIPAA-adjacent construction compliance at this price point.

### Tier Structure

| Feature | Crew ($99/mo) | Builder ($199/mo) | Healthcare Constructor ($299/mo) |
|---------|--------------|-------------------|----------------------------------|
| Daily site logs | ✓ | ✓ | ✓ |
| Inspection checklists | 5 templates | Unlimited | Unlimited + custom |
| Incident reporting | ✓ | ✓ | ✓ |
| Photo attachments | 10/mo | Unlimited | Unlimited |
| Export PDF/CSV | ✓ | ✓ | ✓ |
| OSHA 300 log generation | ✗ | ✓ (Phase 2) | ✓ (Phase 2) |
| Compliance calendar | ✗ | ✓ (Phase 2) | ✓ (Phase 2) |
| Multi-site support | 1 site | 5 sites | Unlimited |
| ICRA compliance module | ✗ | ✗ | ✓ |
| HIPAA-adjacent safety protocols | ✗ | ✗ | ✓ |
| Audit-ready export package | Basic | Standard | Full + BAA template |
| Support SLA | 48h email | 24h email | 12h email |

## Healthcare Construction Moat

Healthcare construction projects (hospital renovations, clinic buildouts, lab retrofits) require **ICRA (Infection Control Risk Assessment)** compliance alongside standard OSHA regulations. This creates a niche where:

1. **Generic construction tools** don't address ICRA dust containment, negative pressure monitoring, or infection control permits
2. **Healthcare compliance tools** (like Compliance Shield) target IT/data privacy, not physical construction safety
3. **ShieldBuild bridges the gap** — OSHA + ICRA in one tool, leveraging EdgeIQ's existing HIPAA expertise from Compliance Shield

The Healthcare Constructor tier includes:
- ICRA risk assessment templates (Class I–IV)
- Dust containment verification checklists
- Negative pressure monitoring logs
- Infection control permit tracking
- HIPAA-adjacent worker safety protocols (bloodborne pathogen exposure, needlestick prevention during demo/construction)
- BAA template for subcontractors handling PHI-adjacent work

This is a defensible niche: competitors would need to build both construction AND healthcare domain expertise.

## Phase 1 Deliverables (Current)

- [x] Landing page at `/shieldbuild/index.html`
- [x] Homepage ticker scroll update
- [x] Homepage New Services grid card
- [x] Product spec document (this file)
- [ ] Stripe products (separate task)
- [ ] Webhook integration (separate task)

## Phase 2 Roadmap

### Backend (Cloudflare Worker)
- User authentication (email/passwordless magic link)
- CRUD API for site logs, inspections, incidents
- Durable Objects for real-time sync across crew devices
- R2 storage for photo attachments

### OSHA 300 PDF Generation
- Server-side PDF rendering of OSHA 300/300A logs
- Auto-calculation of DART rates and incidence rates
- Year-end summary generation
- Electronic signature capture for certification

### Compliance Calendar
- Training expiration tracking (OSHA 10/30, first aid, CPR)
- Permit renewal reminders (excavation, hot work, confined space)
- Equipment inspection scheduling
- Email/SMS alerts 30/14/7 days before expiry

### Offline PWA
- Service Worker for offline-first data entry
- Background sync when connectivity returns
- Local IndexedDB cache for checklist templates
- Conflict resolution for multi-device edits

### Future Considerations
- Mobile app (React Native or Capacitor)
- Subcontractor portal (read-only compliance view)
- Insurance carrier integration (loss run exports)
- State-specific OSHA plan variations (Cal/OSHA, NY OSHA)
