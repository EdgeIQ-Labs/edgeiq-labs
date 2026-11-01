// ShieldInvoice Process — POST /api/shieldinvoice/process
// Accepts PDF (multipart or base64), extracts via OCR, sends to LLM for structured extraction

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, sigB64] = parts;
    const encoder = new TextEncoder();
    
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureInput = `${headerB64}.${payloadB64}`;
    
    // Convert base64url signature back to ArrayBuffer
    const sigBinary = atob(sigB64.replace(/-/g, '+').replace(/_/g, '/'));
    const sigBuffer = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBuffer[i] = sigBinary.charCodeAt(i);
    }
    
    const valid = await crypto.subtle.verify('HMAC', key, sigBuffer, encoder.encode(signatureInput));
    if (!valid) return null;
    
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

async function extractTextFromPDF(pdfBuffer) {
  // Basic PDF text extraction - looks for text between stream/endstream markers
  // This is a fallback; production should use Workers AI OCR binding
  try {
    const text = new TextDecoder('latin1').decode(pdfBuffer);
    const streams = [];
    const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
    let match;
    while ((match = streamRegex.exec(text)) !== null) {
      streams.push(match[1]);
    }
    
    // Extract readable text from streams
    let extracted = '';
    for (const stream of streams) {
      // Look for text showing operators: Tj, TJ, ', "
      const textMatches = stream.match(/\(([^)]*)\)\s*Tj/g);
      if (textMatches) {
        for (const m of textMatches) {
          const content = m.match(/\(([^)]*)\)/);
          if (content) extracted += content[1] + ' ';
        }
      }
    }
    
    // Also try to find plain text in the PDF
    const plainTextMatch = text.match(/\(([A-Za-z0-9\s.,$#%&@!\-]+)\)/g);
    if (plainTextMatch && extracted.length < 50) {
      for (const m of plainTextMatch.slice(0, 100)) {
        const content = m.match(/\(([^)]+)\)/);
        if (content && content[1].length > 2) {
          extracted += content[1] + ' ';
        }
      }
    }
    
    return extracted.trim() || '[PDF text extraction limited - raw content available for LLM processing]';
  } catch (e) {
    return '[PDF parsing error: ' + e.message + ']';
  }
}

async function callLLM(extractedText, apiKey) {
  const prompt = `You are an invoice data extraction assistant. Analyze the following invoice text and extract structured data.

INVOICE TEXT:
${extractedText.substring(0, 8000)}

Return ONLY valid JSON with this exact structure:
{
  "vendorName": "string or null",
  "invoiceNumber": "string or null",
  "date": "YYYY-MM-DD format or null",
  "lineItems": [{"description": "string", "quantity": number, "unitPrice": number, "amount": number}],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "poNumber": "string or null",
  "confidenceScore": number between 0-1,
  "anomalies": ["string descriptions of any issues found"]
}

Rules:
- Parse dates to YYYY-MM-DD format
- Calculate totals if missing but line items exist
- Flag anomalies: duplicate invoice indicators, round amounts over $1000, missing PO when expected, tax calculation mismatches
- Set confidenceScore based on data completeness and clarity
- Return ONLY the JSON object, no markdown fences or explanation`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
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
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`LLM API error: ${resp.status} - ${errText}`);
    }
    
    const result = await resp.json();
    const content = result.choices?.[0]?.message?.content || '';
    
    // Strip markdown fences if present
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }
    
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  
  if (context.request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  
  const kv = context.env.SHIELDINVOICE_KV;
  const jwtSecret = context.env.SHIELDINVOICE_JWT_SECRET || 'shieldinvoice-dev-secret-change-in-prod';
  const llmApiKey = context.env.HERMES_CUSTOM_DIALAGRAM_ME_API_KEY;
  
  if (!kv) return json({ error: 'KV namespace not bound' }, 500);
  if (!llmApiKey) return json({ error: 'LLM API key not configured' }, 500);
  
  // Verify auth
  const authHeader = context.request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return json({ error: 'Authorization required' }, 401);
  }
  
  const user = await verifyJWT(authHeader.slice(7), jwtSecret);
  if (!user) {
    return json({ error: 'Invalid or expired token' }, 401);
  }
  
  try {
    let extractedText = '';
    let fileName = 'upload.pdf';
    let fileSize = 0;
    
    const contentType = context.request.headers.get('Content-Type') || '';
    
    if (contentType.includes('multipart/form-data')) {
      const formData = await context.request.formData();
      const file = formData.get('file');
      
      if (!file || typeof file === 'string') {
        return json({ error: 'No file provided' }, 400);
      }
      
      fileName = file.name || 'upload.pdf';
      const buffer = await file.arrayBuffer();
      fileSize = buffer.byteLength;
      extractedText = await extractTextFromPDF(buffer);
    } else {
      // Expect JSON with base64 PDF
      const body = await context.request.json();
      if (body.pdfBase64) {
        const binary = atob(body.pdfBase64);
        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
        fileSize = buffer.length;
        fileName = body.fileName || 'upload.pdf';
        extractedText = await extractTextFromPDF(buffer);
      } else if (body.text) {
        // Allow pre-extracted text for testing
        extractedText = body.text;
        fileName = body.fileName || 'text-input.txt';
      } else {
        return json({ error: 'Provide file (multipart) or pdfBase64/text (JSON)' }, 400);
      }
    }
    
    // Call LLM for structured extraction
    const extraction = await callLLM(extractedText, llmApiKey);
    
    // Generate invoice ID
    const invoiceId = crypto.randomUUID();
    const now = new Date().toISOString();
    
    const invoiceRecord = {
      id: invoiceId,
      userId: user.sub,
      userEmail: user.email,
      fileName,
      fileSize,
      extractedText: extractedText.substring(0, 5000),
      data: extraction,
      processedAt: now,
      status: 'completed',
    };
    
    // Store in KV
    await kv.put(`invoices:${user.sub}:${invoiceId}`, JSON.stringify(invoiceRecord));
    
    // Update user's invoice index
    const indexKey = `index:${user.sub}`;
    const existingIndex = await kv.get(indexKey, 'json') || [];
    existingIndex.unshift({ id: invoiceId, fileName, processedAt: now, vendorName: extraction.vendorName, total: extraction.total });
    await kv.put(indexKey, JSON.stringify(existingIndex));
    
    // Update stats
    const statsKey = `stats:${user.sub}`;
    const stats = await kv.get(statsKey, 'json') || { totalProcessed: 0, totalAmount: 0, anomalyCount: 0, byMonth: {} };
    const month = now.substring(0, 7);
    stats.totalProcessed++;
    stats.totalAmount += (extraction.total || 0);
    stats.anomalyCount += (extraction.anomalies?.length || 0);
    stats.byMonth[month] = (stats.byMonth[month] || 0) + 1;
    await kv.put(statsKey, JSON.stringify(stats));
    
    return json({ success: true, invoice: invoiceRecord });
    
  } catch (err) {
    console.error('Process error:', err);
    return json({ error: 'Processing failed', message: err.message }, 500);
  }
}
