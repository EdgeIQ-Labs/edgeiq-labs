# Product Specification: Sentinel — Agentic QA by EdgeIQ Labs

**Author:** EdgeIQ Labs Engineering
**Date:** September 15, 2026
**Status:** Draft / MVP Blueprint
**Target:** Internal dogfooding → Open-source release → Commercial product

---

## 1. Product Name

| Option | Rationale |
|--------|-----------|
| **EdgeIQ QA** | Safe, corporate. Boring. Doesn't signal the autonomous differentiator. |
| **Phantom Test** | Edgy, but sounds like a malware strain. Too far into the gothic aesthetic. |
| **Sentinel** | Short, memorable, implies watching and guarding. Aligns with cybersecurity brand. |

**Recommendation: Sentinel** (marketed as *Sentinel by EdgeIQ*). It positions the tool as an autonomous guardian of application quality.

---

## 2. Product Vision

Point Sentinel at a URL. Autonomous agents explore every flow, click every button, fill every form, screenshot failures, log console errors, audit accessibility, validate response times, and generate comprehensive reports. No scripts needed.

Traditional testing requires humans to write brittle selectors that break when a CSS class changes. Sentinel uses LLM-powered vision and DOM understanding to navigate applications like a human would—adapting to UI changes automatically. Built by cybersecurity engineers, it runs entirely inside your own infrastructure. Your application data, credentials, and user flows never leave your network.

---

## 3. Competitive Landscape & The Gap

As of late 2026, the QA market is flooded with "AI" tools that are mostly wrappers around standard automation. Reddit's r/QualityAssurance community remains highly skeptical, noting that most tools offer limited actual ROI over raw Playwright.

| Tool | Price | Hosting | Weakness |
|------|-------|---------|----------|
| **Playwright / Cypress** | Free (OSS) | Self-hosted | Code-first. Requires manual scripting and constant selector maintenance. Not autonomous. |
| **Mabl** | Enterprise SaaS | Cloud only | Auto TFA and agentic features are strong, but data leaves your network. No self-hosted option. |
| **Testim (Tricentis)** | Enterprise SaaS | Cloud only | Heavy, Salesforce-focused, locked behind enterprise sales calls. |
| **Applitools** | Add-on SaaS | Cloud only | Visual regression only. Doesn't crawl or test logic. |
| **QA Wolf** | Managed Service | Cloud only | They write Playwright for you. Expensive, not a platform you own. |
| **Checksum** | SaaS | Cloud only | Generates Playwright/Cypress from sessions, but cloud-dependent. |

**The Gap:** There is no self-hosted, privacy-first, open-core agentic QA tool. Fintech, healthcare, and cybersecurity companies cannot pipe production/staging app data through Mabl or QA Wolf's cloud. Sentinel fills this gap: true LLM-driven autonomy running entirely inside your own Docker infrastructure.

---

## 4. Core Features (MVP)

- **Autonomous Crawl** — Agent starts at a root URL, discovers links/buttons, and systematically explores the application graph without predefined paths.
- **Smart Form Filling** — LLM infers field context (email, password, search, credit card) and generates realistic test data on the fly.
- **Visual Regression** — Screenshot diffing against baselines using pixel-match or SSIM algorithms to catch layout shifts.
- **Console & Network Capture** — Intercepts `console.error`, unhandled promise rejections, and HTTP 4xx/5xx network requests automatically.
- **Accessibility Audit** — Injects axe-core into every visited page to run WCAG 2.1 AA compliance checks.
- **Performance Metrics** — Captures Core Web Vitals (LCP, CLS, INP) and total page load times via Playwright's performance API.
- **CI/CD Integration** — Webhook triggers and a lightweight CLI (`sentinel run --url <target>`) to execute agent runs in GitHub Actions/GitLab CI pipelines.
- **Deterministic Reporting** — Markdown, JSON, and HTML report generation detailing discovered bugs, broken flows, and regressions.

**Explicitly out of scope for MVP:** Mobile app testing, native desktop testing, API-only fuzzing, multi-browser matrix (Chromium only for v1).

---

## 5. Architecture

### Guiding Principle
Must run identically on EdgeIQ's Proxmox/Docker infra and be deployable by any team via a single `docker compose up`. Follows the exact architectural pattern established by Relay.

### Recommended Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | Hono (TypeScript) | Same stack as Relay. Fast, minimal, runs on Node.js. |
| **Frontend** | React via Vite SPA + shadcn/ui | Dark/gothic cybersecurity aesthetic. Consistent with Relay dashboard. |
| **Database** | PostgreSQL + Drizzle ORM | Relational integrity for test runs and assertions. Drizzle generates types. |
| **Queue/Jobs** | BullMQ + Redis | Unlike Relay, agent runs are long-running async jobs. A proper queue is required from Day 1. |
| **Agent Engine** | Playwright | Superior modern web support vs Puppeteer. Native accessibility snapshots save LLM tokens. |
| **LLM Provider** | OpenAI-compatible API | Supports local models (Ollama/vLLM) for air-gapped privacy, or cloud APIs for convenience. |
| **Auth** | Better Auth | Lightweight, JWT-based, matches Relay. |
| **Hosting** | Docker Compose | Single deployment artifact. |

### Data Model (Core Tables)

```
projects: id, name, target_url, created_at
agent_runs: id, project_id, status (queued/running/completed/failed), started_at, completed_at, llm_model, trigger_type (manual/ci/scheduled)
explored_pages: id, run_id, url, status_code, load_time_ms, screenshot_path, created_at
findings: id, run_id, page_id, type (bug/a11y/performance/visual/console/network), severity (critical/high/medium/low), title, description, evidence_path, created_at
baselines: id, project_id, page_identifier, screenshot_path, hash, created_at
assertions: id, project_id, description, enabled, created_at
ci_triggers: id, project_id, webhook_secret, last_triggered_at, created_at
```

---

## 6. Multi-Agent Orchestration (Pro Tier)

Community edition runs a single agent sequentially. Pro tier unlocks parallel execution.

- **Architecture:** BullMQ distributes jobs across multiple worker containers. The `docker-compose.yml` allows scaling workers via `docker compose up --scale sentinel-worker=5`.
- **Flow Partitioning:** The orchestrator crawls the sitemap first, then partitions distinct flows (e.g., `/auth/*`, `/checkout/*`, `/dashboard/*`) to separate agents so they don't collide or duplicate work.
- **Shared Memory:** Agents write findings to the shared PostgreSQL database. If Agent A discovers a login flow, Agent B can reuse the session token if configured.

---

## 7. Monetization Tiers

### Community Edition (Free, Open Source)
- AGPL-3.0 license (prevents SaaS wrappers without contributing back).
- Single agent execution (sequential).
- Basic autonomous crawl and console error capture.
- Docker Compose deployment.
- Community support via GitHub Discussions.
- **Purpose:** Distribution engine. Gets developers using it, builds brand awareness for EdgeIQ.

### Pro License (One-Time Fee: ~$399)
- Everything in Community, plus:
- Multi-agent parallel execution (BullMQ worker scaling).
- CI/CD integration (webhooks + CLI auth tokens).
- Custom natural language assertions (e.g., "Ensure the checkout button is disabled when cart is empty").
- Visual regression baseline management.
- Priority support via Discord.
- License key validation (phone-home to EdgeIQ for activation, works offline with grace period).
- **Why lifetime?** Developers hate subscriptions for infrastructure tools. $399 is impulse-buy territory for engineering teams saving hundreds of hours on QA.

### Managed Service ($149/month)
- Everything in Pro, plus:
- EdgeIQ hosts it for you (multi-tenant SaaS at `sentinel.edgeiqlabs.com`).
- Hosted dashboards with historical trend analysis.
- Slack/Discord/PagerDuty alert integrations.
- Team seats and RBAC (Role-Based Access Control).
- SLA guarantee.
- **Why this exists:** Teams that want the power of Sentinel without managing Docker, Postgres, and Redis infrastructure will pay monthly for zero-ops QA.

---

## 8. Build Phases

Solo developer + AI coding assistant. Assuming 4-6 hours/day focused work.

| Phase | Scope | Duration |
|-------|-------|----------|
| **Phase 1: Scaffold** | pnpm monorepo setup, Hono API skeleton, Drizzle schema, Docker Compose (Postgres, Redis, API, Worker), Better Auth integration. | Week 1 |
| **Phase 2: Core Engine** | Playwright integration, LLM decision loop (prompting for next action based on DOM/accessibility tree), basic link clicking and navigation. | Weeks 2-3 |
| **Phase 3: Reporting** | Screenshot capture, axe-core injection, console/network interceptors, finding generation, DB persistence. | Week 4 |
| **Phase 4: Dashboard** | React+Vite SPA shell, dark theme styling, project management, run history table, finding detail views with embedded screenshots. | Week 5 |
| **Phase 5: CI Integration** | Webhook receiver for triggering runs, CLI tool (`sentinel-cli`), GitHub Action wrapper, exit code logic for failing pipelines. | Week 6 |
| **Phase 6: Dogfood** | Point Sentinel at `relay.edgeiqlabs.com` and `edgeiqlabs.com`. Fix agent loops, improve prompt strategies, handle edge cases. | Week 7 |
| **Phase 7: Polish & Ship** | README, docs, landing page, AGPL licensing, GitHub release, announcement. | Week 8 |

**Total: 8 weeks to public v1.** Phase 2 (LLM loop) and Phase 6 (Dogfooding) are the highest risk areas.

---

## 9. Tech Stack Details

### Project Structure
```
sentinel/
├── packages/
│   ├── core/          # DB schemas, types, shared utilities
│   ├── api/           # Hono routes (REST API, webhooks)
│   ├── agent/         # Playwright + LLM orchestration engine
│   ├── worker/        # BullMQ job processors
│   └── web/           # React SPA (dashboards)
├── docker-compose.yml
├── drizzle.config.ts
└── package.json       # pnpm workspace root
```

### API Routes (Hono)
- `POST /api/projects` — Create a target project.
- `GET /api/projects/:id/runs` — List agent runs for a project.
- `POST /api/runs` — Trigger a new agent run (manual or CI).
- `GET /api/runs/:id/findings` — Retrieve bugs/issues found.
- `POST /api/webhooks/ci/:token` — CI/CD trigger endpoint.
- `GET /api/baselines/:project_id` — Manage visual regression baselines.

### Agent Prompt Strategy
The agent operates in a continuous loop:
1. **Observe:** Extract the accessibility tree via `page.accessibility.snapshot()` (saves massive LLM tokens compared to raw HTML).
2. **Orient:** System prompt defines the persona: *"You are an autonomous QA tester exploring a web application. Your goal is to find bugs, broken flows, and accessibility issues."*
3. **Decide:** LLM outputs structured JSON: `{"action": "click", "selector": "button[name='submit']"}` or `{"action": "fill", "selector": "#email", "value": "test@example.com"}`.
4. **Act:** Playwright executes the action.
5. **Evaluate:** Check for console errors, network failures, or visual anomalies after the action. Log findings to DB.
6. **Repeat** until coverage goals are met or max steps exceeded.

---

## 10. Deployment

Follows the exact EdgeIQ Labs infrastructure pattern established by Relay.

- **Infrastructure:** Proxmox VM (Deployr-5, 10.18.157.11).
- **Containerization:** Docker Compose. Services: `postgres`, `redis`, `api`, `worker`, `web`, `migrate`.
- **Reverse Proxy:** Traefik routing `sentinel.edgeiqlabs.com` to the API/Web containers.
- **DNS:** Cloudflare DNS pointing to Deployr-5 public IP, proxied through CF for DDoS protection.
- **Base Image:** `node:20-slim` with Playwright dependencies installed via `npx playwright install --with-deps chromium`.
- **Environment Variables:** `DATABASE_URL`, `REDIS_URL`, `LLM_API_KEY`, `LLM_BASE_URL` (for Ollama/local models), `BETTER_AUTH_SECRET`.

---

## 11. Landing Page Copy Outline (for edgeiqlabs.com/sentinel)

### Hero Section
**Headline:** Stop writing tests. Start deploying guards.
**Subheadline:** Sentinel is the open-source, self-hosted agentic QA platform. Point it at your app, and autonomous AI agents will crawl, click, and break everything before your users do. No scripts. No cloud exfiltration.
**CTA:** [View on GitHub] [Try Live Demo]
**Visual:** Terminal showing `sentinel run --url https://myapp.com` transitioning into a dark-themed dashboard full of discovered findings.

### Problem Section
**Header:** Your QA pipeline is a liability.
**Copy:** Playwright and Cypress require armies of engineers to maintain brittle selectors. Cloud AI tools like Mabl and QA Wolf demand you pipe your application's internal data through their servers. We're a cybersecurity firm. We refuse both options.

### How It Works (3 Steps)
1. **Point.** Give Sentinel a URL and an LLM endpoint (local or cloud).
2. **Explore.** Autonomous agents map your application, fill forms, and hunt for edge cases using vision and DOM understanding.
3. **Report.** Get deterministic findings with screenshots, console logs, and accessibility violations. Fail your CI pipeline automatically.

### Pricing Section

| Community | Pro | Managed |
|-----------|-----|---------|
| Free forever | $399 one-time | $149/month |
| Open source (AGPL) | Everything in Community | Everything in Pro |
| Single agent | Multi-agent parallel | We host it for you |
| Basic crawl | CI/CD integration | Team seats & RBAC |
| Docker self-hosted | Custom assertions | Alert integrations |
| Community support | Priority Discord support | SLA guarantee |
| [Get Started] | [Buy License] | [Contact Sales] |

---

## Appendix: EdgeIQ Dogfooding Checklist

Before open-sourcing, validate against our own use case:

- [ ] Point Sentinel at `relay.edgeiqlabs.com` partner signup flow
- [ ] Verify agent autonomously fills registration form and submits
- [ ] Confirm console errors from Relay are captured as findings
- [ ] Validate axe-core catches intentional a11y violations on staging
- [ ] Test visual regression against Relay dashboard baseline
- [ ] Wire CLI trigger into Relay's GitHub Actions CI pipeline
- [ ] Run load test: ensure parallel agents don't crash the staging DB
- [ ] Validate Docker Compose deploys cleanly on Deployr-5 via Traefik
