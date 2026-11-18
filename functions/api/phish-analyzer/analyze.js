// Phishing Report Analyzer - Core analysis engine
// Supports both JSON ({email, pro_key}) and multipart (email text + optional PDF attachment)
// PDF forensics is Pro-only; free tier gets email analysis only

export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    let email = '';
    let pro_key = null;
    let pdfFile = null;

    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      email = formData.get('email') || '';
      pro_key = formData.get('pro_key') || null;
      pdfFile = formData.get('pdf') || null;
    } else {
      // Backward compat: JSON body
      const body = await request.json();
      email = body.email || '';
      pro_key = body.pro_key || null;
    }

    if (!email || email.length < 10) {
      return new Response(JSON.stringify({ error: "Invalid email content" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // Check if user is Pro subscriber (bypass rate limit + show all indicators + PDF analysis)
    let isPro = false;
    if (pro_key) {
      try {
        const sub = await env.PHISH_DB.prepare(
          "SELECT tier, status FROM subscribers WHERE email = ? AND status = 'active'"
        ).bind(pro_key).first();
        if (sub && sub.tier === 'pro') isPro = true;
      } catch (e) { /* D1 not bound yet */ }
    }

    // Rate limiting via KV for free tier only
    if (!isPro) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateKey = `phish-rate:${ip}`;
      let count = parseInt(await env.PULSE_KV.get(rateKey) || "0");
      if (count >= 5) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Upgrade to Pro for unlimited." }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      await env.PULSE_KV.put(rateKey, String(count + 1), { expirationTtl: 86400 });
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

    // Free tier: max 3 indicators. Pro: all indicators.
    let returnedIndicators = indicators;
    if (!isPro && indicators.length > 3) {
      returnedIndicators = indicators.slice(0, 3);
      returnedIndicators.push(`+${indicators.length - 3} more indicators (upgrade to Pro for full report)`);
    }

    // ── PDF Attachment Forensics (Pro only) ──────────────────────────────────────
    let pdfResult = null;
    if (pdfFile && isPro) {
      try {
        const pdfBuffer = await pdfFile.arrayBuffer();
        const extractedText = extractPdfText(pdfBuffer);
        
        if (extractedText && extractedText.length > 20) {
          const llmApiKey = env.HERMES_CUSTOM_DIALAGRAM_ME_API_KEY || env.DIALAGRAM_API_KEY;
          if (llmApiKey) {
            const financialData = await extractFinancialData(extractedText, llmApiKey);
            const fraudFlags = crossReferenceFraud(financialData, email, indicators);
            
            pdfResult = {
              extracted: true,
              financial_data: financialData,
              fraud_flags: fraudFlags,
              text_length: extractedText.length
            };
            
            // Add fraud flags to main indicators
            for (const flag of fraudFlags) {
              score += 10;
              returnedIndicators.push(`📎 PDF: ${flag}`);
            }
            score = Math.min(score, 100);
            
            // Re-evaluate verdict with PDF data
            if (score >= 60) verdict = "malicious";
            else if (score >= 30) verdict = "suspicious";
          }
        }
      } catch (e) {
        pdfResult = { extracted: false, error: e.message };
      }
    } else if (pdfFile && !isPro) {
      pdfResult = { extracted: false, error: "PDF analysis requires Pro subscription" };
    }

    // Log analysis to D1
    try {
      const emailHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.substring(0, 200)));
      const hashHex = Array.from(new Uint8Array(emailHash)).map(b => b.toString(16).padStart(2, "0")).join("").substring(0, 32);
      await env.PHISH_DB.prepare(
        "INSERT INTO analyses (id, email_hash, verdict, score, indicators_count, urls_found, subscriber_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
      ).bind(hashHex + Date.now(), hashHex, verdict, score, indicators.length, urls.length, pro_key || null).run();
    } catch (e) { /* D1 not bound yet, non-fatal */ }

    const response = {
      verdict,
      score,
      indicators: returnedIndicators,
      total_indicators: indicators.length,
      urls_found: urls.length,
      is_pro: isPro,
      analyzed_at: new Date().toISOString()
    };
    
    if (pdfResult) response.pdf = pdfResult;

    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: "Analysis failed: " + e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// ── PDF Text Extraction (inline from shieldinvoice/process.js) ─────────────────
function extractPdfText(pdfBuffer) {
  try {
    const text = new TextDecoder('latin1').decode(pdfBuffer);
    let extracted = '';
    
    // Extract text from PDF stream objects
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    let match;
    while ((match = streamRegex.exec(text)) !== null) {
      const stream = match[1];
      // Look for text showing operators: Tj, TJ
      const textMatches = stream.match(/\(([^)]*)\)\s*Tj/g);
      if (textMatches) {
        for (const m of textMatches) {
          const content = m.match(/\(([^)]*)\)/);
          if (content) extracted += content[1] + ' ';
        }
      }
    }
    
    // Fallback: find plain text patterns
    if (extracted.length < 50) {
      const plainTextMatch = text.match(/\(([A-Za-z0-9\s.,$#%&@!\-]+)\)/g);
      if (plainTextMatch) {
        for (const m of plainTextMatch.slice(0, 100)) {
          const content = m.match(/\(([^)]+)\)/);
          if (content && content[1].length > 2) {
            extracted += content[1] + ' ';
          }
        }
      }
    }
    
    return extracted.trim();
  } catch (e) {
    return '';
  }
}

// ── LLM Financial Data Extraction ──────────────────────────────────────────────
async function extractFinancialData(text, apiKey) {
  const prompt = `Extract financial data from this document text. Return ONLY valid JSON:
{
  "vendorName": "string or null",
  "amounts": [{"description": "string", "amount": number}],
  "accountNumbers": ["string"],
  "routingNumbers": ["string"],
  "wireInstructions": boolean,
  "paymentDueDate": "YYYY-MM-DD or null",
  "invoiceNumber": "string or null",
  "totalAmount": number or null,
  "currency": "string or null"
}

DOCUMENT TEXT:
${text.substring(0, 6000)}

Return ONLY the JSON object, no markdown fences.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  
  try {
    const resp = await fetch('https://dialagram.me/router/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen-3.7-plus',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!resp.ok) throw new Error(`LLM error: ${resp.status}`);
    
    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

// ── Fraud Cross-Reference Engine ───────────────────────────────────────────────
function crossReferenceFraud(financialData, emailText, existingIndicators) {
  if (!financialData) return [];
  
  const flags = [];
  const lowerEmail = emailText.toLowerCase();
  
  // 1. Wire transfer + urgency = BEC indicator
  if (financialData.wireInstructions && existingIndicators.some(i => /urgency|immediate|24 hour/i.test(i))) {
    flags.push("Wire transfer request combined with urgency language — potential BEC attack");
  }
  
  // 2. Large round amounts are suspicious
  if (financialData.totalAmount && financialData.totalAmount >= 10000 && financialData.totalAmount % 1000 === 0) {
    flags.push(`Round dollar amount ($${financialData.totalAmount.toLocaleString()}) — common in invoice fraud`);
  }
  
  // 3. Vendor name mismatch with email sender
  if (financialData.vendorName) {
    const vendorLower = financialData.vendorName.toLowerCase();
    const fromMatch = emailText.match(/From:\s*<?([^>\n]+)/i);
    if (fromMatch) {
      const fromDomain = (fromMatch[1].match(/@([\w.-]+)/) || [])[1] || '';
      if (fromDomain && !fromDomain.includes(vendorLower.replace(/\s+/g, '')) && !vendorLower.includes(fromDomain.split('.')[0])) {
        flags.push(`Invoice vendor "${financialData.vendorName}" doesn't match sender domain (${fromDomain})`);
      }
    }
  }
  
  // 4. Account/routing numbers present in email context
  if (financialData.accountNumbers && financialData.accountNumbers.length > 0) {
    flags.push(`Bank account number found in attachment (${financialData.accountNumbers.length} account${financialData.accountNumbers.length > 1 ? 's' : ''})`);
  }
  
  // 5. Payment due date very soon (urgency tactic)
  if (financialData.paymentDueDate) {
    try {
      const due = new Date(financialData.paymentDueDate);
      const now = new Date();
      const daysUntilDue = (due - now) / (1000 * 60 * 60 * 24);
      if (daysUntilDue >= 0 && daysUntilDue <= 3) {
        flags.push(`Payment due within ${Math.ceil(daysUntilDue)} day(s) — artificial urgency tactic`);
      }
    } catch (e) {}
  }
  
  return flags;
}
