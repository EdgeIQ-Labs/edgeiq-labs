#!/usr/bin/env python3
"""
EdgeIQ Labs — Hashnode Autopublisher
Runs every Mon/Wed/Fri on cron. Posts fresh unique content to Hashnode.

NOTE: Hashnode's API is blocked from server-side environments due to Cloudflare
bot protection. This script works from local machines or GitHub Actions.
Test with: python3 hashnode_autopilot.py --dry-run

Cron: 0 10 * * 1,3,5  (Mon/Wed/Fri 10am ET)
"""

import json, requests, sys, os
from datetime import datetime

HASHNODE_KEY = os.getenv("HASHNODE_KEY", "b28d18a9-8a69-49db-8460-597dfff6791a")
STATE_FILE = "/home/guy/.openclaw/workspace/temp/hashnode_autopilot_state.json"
API_URL = "https://hashnode.com/api/graphql"

PRODUCT_QUEUE = [
    {
        "slug": "brand-guard",
        "tagline": "I built a tool that catches phishing sites cloning my product before customers notice",
        "hook": "Someone is always trying to clone your brand. Most founders find out about it from their customers, not from their own tooling.",
        "body_intro": "Brand impersonation and phishing kit detection with live alerts.",
    },
    {
        "slug": "fraud-check",
        "tagline": "I built a checkout scam detector so my customers stop getting burned",
        "hook": "You can't stop attackers from building fake checkout pages. But you can warn customers before they enter their card details.",
        "body_intro": "Checkout scam URL detector built on phishing kit detection infrastructure.",
    },
    {
        "slug": "cert-alert",
        "tagline": "I built an SSL cert monitor that catches revocations before they bite you",
        "hook": "Certificate revocations are silent killers. Your cert can be revoked the same day you renew it and most tools won't catch it until users start reporting errors.",
        "body_intro": "SSL certificate expiration and revocation monitoring via Certificate Transparency logs.",
    },
    {
        "slug": "inbox-shield",
        "tagline": "I graded my domain's email security and got a C-",
        "hook": "SPF, DKIM, and DMARC sound like alphabet soup. Most people set them once and forget about them. Then email deliverability starts suffering and they have no idea why.",
        "body_intro": "Email security grader covering SPF, DKIM, DMARC, MX, and BIMI with 29 DKIM selector checks.",
    },
    {
        "slug": "subdomain-takeover",
        "tagline": "I found 3 expired S3 buckets pointing to my subdomain before an attacker did",
        "hook": "Subdomain takeovers are one of the most overlooked attack vectors. A forgotten staging environment that expired can give an attacker control of your subdomain.",
        "body_intro": "Automated dangling DNS detection for expired AWS S3, GitHub Pages, Heroku, Azure, Netlify, and Vercel resources.",
    },
    {
        "slug": "vendor-watch",
        "tagline": "I built a tool that alerts me when Stripe and GitHub go down before my customers do",
        "hook": "You find out your SaaS is down the same time your customers do. That's a problem.",
        "body_intro": "Real-time SaaS status monitoring for 14 major vendors with 3-minute check intervals.",
    },
    {
        "slug": "compliance-tracker",
        "tagline": "I ran a SOC 2 scan on my startup and failed 40% of checks",
        "hook": "Compliance frameworks are not just for enterprises. If you're handling any customer data, you have a compliance posture whether you know it or not.",
        "body_intro": "SOC 2, HIPAA, and PCI-DSS compliance scoring with month-over-month trend tracking.",
    },
    {
        "slug": "surface-map",
        "tagline": "I mapped my API attack surface so attackers couldn't do it first",
        "hook": "Your API attack surface changes constantly — new endpoints, forgotten staging environments, shadow APIs. If you don't know what's exposed, an attacker will find it for you.",
        "body_intro": "Automated API attack surface mapping and continuous monitoring with A-F security grading.",
    },
]

PRODUCT_DETAILS = {
    "brand-guard": {
        "name": "BrandGuard",
        "price": "$14/mo Pro",
        "free": "N/A",
        "pro": "Brand impersonation detection, lookalike domains, phishing kit monitoring",
        "url": "https://edgeiqlabs.com/product/brand-guard/",
    },
    "fraud-check": {
        "name": "FraudCheck",
        "price": "$9/mo Pro",
        "free": "N/A",
        "pro": "Checkout scam URL detection, brand impersonation flags, dark web intel",
        "url": "https://edgeiqlabs.com/product/fraud-check/",
    },
    "cert-alert": {
        "name": "Cert Alert",
        "price": "$9/mo Pro",
        "free": "N/A",
        "pro": "SSL expiry alerts (30/7/1 day), revocation detection, CT log tracking",
        "url": "https://edgeiqlabs.com/product/cert-alert/",
    },
    "inbox-shield": {
        "name": "EdgeIQ Inbox Shield",
        "price": "$15/mo Pro",
        "free": "Instant scan + weekly digest",
        "pro": "Daily monitoring, DKIM rotation alerts, 5 domains, A-F grade",
        "url": "https://edgeiqlabs.com/product/inbox-shield/",
    },
    "subdomain-takeover": {
        "name": "Subdomain Takeover Scanner",
        "price": "$14/mo Pro",
        "free": "N/A",
        "pro": "Dangling DNS detection (S3, GitHub Pages, Heroku, Azure, Netlify, Vercel)",
        "url": "https://edgeiqlabs.com/product/subdomain-takeover/",
    },
    "vendor-watch": {
        "name": "Vendor Watch",
        "price": "$9/mo Pro",
        "free": "5 vendors, email alerts",
        "pro": "14 vendors, all-clear alerts, webhook support",
        "url": "https://edgeiqlabs.com/product/vendor-watch/",
        "check_interval": "3 minutes",
    },
    "compliance-tracker": {
        "name": "Compliance Posture Tracker",
        "price": "$49/mo Essential",
        "free": "On-demand scan, browser score history",
        "pro": "SOC2 + HIPAA + PCI, auto monthly scans, 3 domains, PDF export",
        "url": "https://edgeiqlabs.com/product/compliance-tracker/",
    },
    "surface-map": {
        "name": "SurfaceMap",
        "price": "$19/mo Pro",
        "free": "N/A",
        "pro": "API attack surface mapping, new exposure alerts, A-F security grade",
        "url": "https://edgeiqlabs.com/product/surface-map/",
    },
}


def get_next_product():
    state = {"index": 0}
    if os.path.exists(STATE_FILE):
        try:
            state = json.load(open(STATE_FILE))
        except Exception:
            pass

    idx = state.get("index", 0) % len(PRODUCT_QUEUE)
    product = PRODUCT_QUEUE[idx]
    state["index"] = (idx + 1) % len(PRODUCT_QUEUE)

    with open(STATE_FILE, "w") as f:
        json.dump(state, f)

    return product


def build_mutation(product_slug, details, queue_entry):
    """Build the GraphQL mutation for Hashnode."""
    title = queue_entry["tagline"]
    body = f"""{queue_entry["hook"]}

{queue_entry["body_intro"]}

**What it does:**
- {details["pro"]}
- Free tier: {details["free"]}
- Price: {details["price"]}
- Checks every {details.get("check_interval", "configured interval")}

**Why I built this:**
Most security tools are built for enterprises with dedicated security teams. These started as internal scripts that solved real problems — now they're packaged for any indie hacker or small team that can't afford enterprise tooling but still needs to know when something breaks.

**Who it's for:**
- Developers running their own infrastructure
- Indie hackers who can't afford enterprise security tools
- Small teams that need to know about problems before customers do

**Try it:** {details["url"]}

---
*Automated post from EdgeIQ Labs*
"""

    mutation = f"""mutation {{
createStory(
    input: {{
        title: "{title.replace('"', '\\"')}",
        contentMarkdown: \"\"\"{body}\"\"\",
        tags: [{{ name: "security" }}, {{ name: "devops" }}, {{ name: "saas" }}]
    }}
) {{
    code
    success
    message
}}
}}"""
    return mutation


def post_article(mutation):
    """Post article to Hashnode via GraphQL."""
    resp = requests.post(
        API_URL,
        headers={
            "Authorization": HASHNODE_KEY,
            "Content-Type": "application/json",
            "User-Agent": "EdgeIQ-Labs/1.0",
        },
        json={"query": mutation},
        timeout=30,
    )
    return resp


def main():
    dry_run = "--dry-run" in sys.argv

    product = get_next_product()
    details = PRODUCT_DETAILS.get(product["slug"], {})
    mutation = build_mutation(product["slug"], details, product)

    print(f"[{datetime.now().isoformat()}] Hashnode autopost: {product['slug']}")
    print(f"Title: {product['tagline']}")

    if dry_run:
        print("DRY RUN — not posting")
        print(mutation[:500])
        return

    resp = post_article(mutation)
    r = resp.json()

    if resp.status_code == 200 and r.get("data", {}).get("createStory", {}).get("success"):
        print(f"SUCCESS: {r['data']['createStory']['message']}")
    else:
        print(f"FAILED: {json.dumps(r, indent=2)}")


if __name__ == "__main__":
    main()