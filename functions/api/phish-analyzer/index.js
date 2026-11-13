export async function onRequestGet() {
  return new Response(JSON.stringify({
    service: "Phishing Report Analyzer",
    version: "1.0.0",
    tiers: {
      free: { price: "$0/mo", features: ["Basic verdict", "Top 3 indicators", "5 analyses/day"] },
      pro: { price: "$29/mo", features: ["Full forensic report", "Unlimited analyses", "Historical lookups", "Bulk API", "Team sharing", "DNS Firewall integration"] }
    },
    endpoints: {
      analyze: "POST /api/phish-analyzer/analyze",
      checkout: "GET /api/phish-analyzer-checkout?plan=pro",
      webhook: "POST /api/phish-analyzer/webhook"
    }
  }), { headers: { "Content-Type": "application/json" } });
}
