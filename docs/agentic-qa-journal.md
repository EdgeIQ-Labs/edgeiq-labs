# Sentinel (Agentic QA) — Project Journal

> Persistent log of decisions, progress, and blockers. Carries across sessions.

---

## 2026-09-15 — Day Zero

### Context
- EdgeIQ Labs SaaS #2 officially spec'd out.
- Relay (SaaS #1) is currently in Phase 6 (Dogfood Integration) and deployed in production at relay.edgeiqlabs.com.
- Sentinel selected as second build because QA friction is universal, and the market lacks a true self-hosted, privacy-first agentic testing tool.

### Inspiration
- Frustration with brittle Playwright/Cypress tests that require constant maintenance.
- 2026 QA landscape research shows tools like Mabl, Testim, and QA Wolf are moving toward agentic AI, but all are cloud-locked or prohibitively expensive.
- Reddit r/QualityAssurance sentiment confirms developers are tired of "AI wrappers" around standard automation—they want actual autonomous exploration.
- Core thesis: Cybersecurity and fintech companies cannot use cloud QA tools due to data privacy. An AGPL-3.0 self-hosted Docker solution running local LLMs fills a massive gap.

### Competitive Landscape (researched 2026-09-15)
| Tool | Price | Hosting | Weakness |
|------|-------|---------|----------|
| **Playwright** | Free (OSS) | Self-hosted | Code-first, requires manual scripting. Not autonomous. |
| **Mabl** | Enterprise SaaS | Cloud only | Auto TFA is great, but data leaves your network. No self-hosted option. |
| **Testim** | Enterprise SaaS | Cloud only | Heavy, Salesforce-focused, locked behind sales calls. |
| **Applitools** | Add-on SaaS | Cloud only | Visual only. Doesn't crawl or test logic. |
| **QA Wolf** | Managed | Cloud only | They write Playwright for you. Expensive, not a platform you own. |

**Our wedge:** True LLM-driven autonomy, running entirely inside your own Docker infrastructure. No cloud exfiltration. Open-core.

### Decisions Made
- **Product Name:** Sentinel (fits the dark, gothic, cybersecurity brand of EdgeIQ Labs).
- **Repo:** `EdgeIQ-Labs/sentinel` (to be created, public, GitHub).
- **Architecture:** Exact match to Relay. pnpm monorepo, Hono API, Drizzle + PostgreSQL, React+Vite frontend, Docker Compose.
- **Agent Engine:** Playwright over Puppeteer (better modern web support, native accessibility snapshots save LLM tokens).
- **Queue System:** BullMQ + Redis added to the stack (unlike Relay's MVP, agent runs are inherently long-running async jobs requiring a proper queue from Day 1).
- **Monetization:** AGPL-3.0 Community, $399 Lifetime Pro, $149/mo Managed.
- **Deployment Target:** Deployr-5 (10.18.157.11) via Traefik, routing `sentinel.edgeiqlabs.com`.

### Status
- [x] Competitor research completed
- [x] Product vision defined
- [x] Architecture spec written
- [x] Project journal initialized
- [ ] Repo scaffolded on GitHub
- [ ] Phase 1: Monorepo scaffold & Docker Compose setup
- [ ] Phase 2: Core agent engine (Playwright + LLM loop)

### Blockers
None yet. Waiting on Relay Phase 6/7 completion before shifting primary development focus to Sentinel. Spec is ready for when the transition happens.

---
