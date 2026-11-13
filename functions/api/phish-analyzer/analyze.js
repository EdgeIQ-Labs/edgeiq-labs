// Phishing Report Analyzer - Core analysis engine
export async function onRequestPost(context) {
  const { request, env } = context;
  
  // Rate limiting via KV for free tier
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateKey = `phish-rate:${ip}`;
  let count = parseInt(await env.PULSE_KV.get(rateKey) || "0");
  if (count >= 5) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Upgrade to Pro for unlimited." }), { status: 429, headers: { "Content-Type": "application/json" } });
  }
  await env.PULSE_KV.put(rateKey, String(count + 1), { expirationTtl: 86400 });

  try {
    const { email } = await request.json();
    if (!email || email.length < 10) {
      return new Response(JSON.stringify({ error: "Invalid email content" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const indicators = [];
    let score = 0; // 0=safe, 100=definitely malicious

    // 1. Header checks
    const lowerEmail = email.toLowerCase();
    
    // SPF/DKIM/DMARC failures
    if (/spf.*fail/i.test(email)) { score += 25; indicators.push("SPF authentication failed"); }
    if (/dkim.*fail/i.test(email)) { score += 20; indicators.push("DKIM signature invalid"); }
    if (/dmarc.*fail/i.test(email)) { score += 25; indicators.push("DMARC policy violation"); }
    
    // Reply-To mismatch
    const fromMatch = email.match(/From:\s*<?([^>\n]+)/i);
    const replyToMatch = email.match(/Reply-To:\s*<?([^>\n]+)/i);
    if (fromMatch && replyToMatch) {
      const fromDomain = (fromMatch[1].match(/@([\w.-]+)/) || [])[1];
      const replyDomain = (replyToMatch[1].match(/@([\w.-]+)/) || [])[1];
      if (fromDomain && replyDomain && fromDomain !== replyDomain) {
        score += 20;
        indicators.push(`Reply-To domain (${replyDomain}) differs from From (${fromDomain})`);
      }
    }

    // 2. URL analysis
    const urls = email.match(/https?:\/\/[^\s<>"']+/gi) || [];
    const suspiciousTlds = [".xyz", ".top", ".click", ".link", ".tk", ".ml", ".ga", ".cf"];
    for (const url of urls.slice(0, 10)) {
      const tld = suspiciousTlds.find(t => url.endsWith(t) || url.includes(t + "/"));
      if (tld) { score += 10; indicators.push(`Suspicious TLD in URL: ${tld}`); break; }
      if (/bit\.ly|tinyurl|t\.co|rb\.gy/i.test(url)) { score += 5; indicators.push("Shortened URL detected (common in phishing)"); break; }
    }

    // 3. Content scoring - urgency/social engineering
    const urgencyPatterns = [
      /immediate action required/i, /your account will be suspended/i,
      /verify your identity now/i, /unauthorized transaction/i,
      /click here immediately/i, /within 24 hours/i, /urgent:/i,
      /dear customer/i, /dear user/i, /confirm your password/i
    ];
    let urgencyCount = 0;
    for (const pattern of urgencyPatterns) {
      if (pattern.test(email)) urgencyCount++;
    }
    if (urgencyCount >= 2) { score += 15; indicators.push(`${urgencyCount} urgency/social engineering phrases detected`); }
    else if (urgencyCount === 1) { score += 5; indicators.push("Urgency language detected"); }

    // 4. Brand impersonation heuristics
    const brands = ["microsoft", "apple", "google", "amazon", "paypal", "netflix", "bank", "chase", "wells fargo"];
    for (const brand of brands) {
      if (lowerEmail.includes(brand) && !lowerEmail.includes(`@${brand}.com`) && !lowerEmail.includes(`@${brand}.net`)) {
        score += 15;
        indicators.push(`Possible ${brand} impersonation (sender not from official domain)`);
        break;
      }
    }

    // Cap score at 100
    score = Math.min(score, 100);

    // Determine verdict
    let verdict = "safe";
    if (score >= 60) verdict = "malicious";
    else if (score >= 30) verdict = "suspicious";

    // Return top indicators for free tier (max 3)
    const returnedIndicators = indicators.slice(0, 3);
    if (indicators.length > 3) {
      returnedIndicators.push(`+${indicators.length - 3} more indicators (upgrade to Pro for full report)`);
    }

    return new Response(JSON.stringify({
      verdict,
      score,
      indicators: returnedIndicators,
      total_indicators: indicators.length,
      urls_found: urls.length,
      analyzed_at: new Date().toISOString()
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Analysis failed: " + e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
