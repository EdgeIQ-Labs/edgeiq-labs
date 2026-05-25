# EdgeIQ Site — Project Context

## What This Repo Is
The edgeiqlabs.com website. Hosted on Cloudflare Pages, auto-deploys from GitHub EdgeIQ-Labs/edgeiq-labs master branch.

## Key Pages
| Path | Description |
|---|---|
| `/index.html` | Homepage — has announcement bar, paths cards, sister-services section |
| `/play/index.html` | Game server hosting storefront (green theme) |
| `/bots/index.html` | Discord bot hosting storefront (purple theme) |
| `/play/rules/index.html` | Community rules for EdgeIQ Public MC server |
| `/vps/index.html` | VPS hosting storefront (teal theme #2dd4bf) |
| `/terms.html` | Terms of service |
| `/privacy.html` | Privacy policy |
| `/sitemap.xml` | Sitemap — update when adding pages |
| `/stripe-payment-links.json` | All Stripe payment links by plan name |

## Webhook Folder
`/webhook/` — source code for the automated onboarding server.
- `server.js` — main webhook handler (Stripe → Pterodactyl → Resend email)
- `package.json` — dependencies (express, stripe)
- NOT deployed from this repo — deployed manually to /opt/edgeiq-webhook/ on VM

## Stripe Payment Links (in stripe-payment-links.json)
- play_starter_monthly, play_standard_monthly, play_pro_monthly
- bots_basic_monthly, bots_standard_monthly, bots_pro_monthly

## Stripe Price IDs (in webhook/server.js PLANS)
### Game Plans (egg 1, nest 1, Paper MC)
- Play Starter: price_1TaKiBRC1NZ20yDTRpsosVTW (monthly)
- Play Standard: price_1TaKiBRC1NZ20yDTWpWHqkdB
- Play Pro: price_1TaKiBRC1NZ20yDTzX0wj9FM

### Bot Plans (egg 23, nest 6, Node.js)
- Bots Basic: price_1Taf51RC1NZ20yDTAubMcjxY (monthly)
- Bots Standard: price_1Taf5GRC1NZ20yDTL9GZToCI
- Bots Pro: price_1Taf5GRC1NZ20yDTmWZBrxng

## Git Workflow
```bash
git add <specific files>   # NEVER git add -u or git add .
git commit -m "message"
git push origin master     # triggers Cloudflare Pages deploy
```

## Design System
- Background: #0b0f14
- Card: #121923
- Text: #e8eef7
- Muted: #9fb0c7
- Blue accent: #3dd9ff (main site / MSP)
- Green accent: #4ade80 (Play / game servers)
- Purple accent: #7c6fef (Bots)
- Teal accent: #2dd4bf (VPS / Cloud)
- Border: #233142

## VPS Plans (manual provisioning for now — automation in progress)
- Nano: $4/mo — 1 vCPU, 512MB RAM, 10GB SSD
- Micro: $7/mo — 1 vCPU, 1GB RAM, 20GB SSD
- Basic: $12/mo — 2 vCPU, 2GB RAM, 40GB SSD
- Standard: $22/mo — 4 vCPU, 4GB RAM, 80GB SSD
- Stripe price IDs: Nano price_1Tb2VFRC1NZ20yDTfhCJ6651 · Micro price_1Tb2VHRC1NZ20yDTPFoMZmhj · Basic price_1Tb2VJRC1NZ20yDTIFFVAmJb · Standard price_1Tb2VKRC1NZ20yDTawsJRCJ6
- Payment links in stripe-payment-links.json (vps_nano_monthly → vps_standard_monthly)

## VPS Infrastructure (Proxmox)
- NAT bridge: vmbr2 (10.10.0.1/24), MASQUERADE through vmbr0
- Port ranges: 22000-22999 (SSH), 30000-39999 (general)
- DNAT: iptables PREROUTING on Proxmox routes to LXC containers
- Templates: ubuntu-24.04-standard on Tank (ZFS, 1.08TB free)

## Pending Tasks
- [ ] Create Stripe products for VPS plans and replace mailto: links
- [ ] Build VPS automation (Proxmox API → LXC provisioning on payment)
- [ ] Post advertising: SpigotMC, Reddit r/admincraft, Facebook groups
- [ ] MSP cold email infrastructure
- [ ] findmcserver.com listing (pending review queue — workbook completed)
