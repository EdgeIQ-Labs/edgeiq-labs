import * as XLSX from 'xlsx';

// --- Types ---
interface KBEntry {
  answer: string;
  source: string;
  updatedAt: string;
}

interface QuestionnaireQuestion {
  id: string;
  question: string;
  category?: string;
}

interface LLMResponse {
  answers: Array<{
    id: string;
    answer: string;
    confidence: 'high' | 'medium' | 'low';
    source: string;
  }>;
}

// --- Env Bindings ---
interface Env {
  SHIELDFILL_KV: KVNamespace;
  LLM_MODEL: string;
  LLM_BASE_URL: string;
  LLM_API_KEY: string; // Stored as secret in wrangler
  RESEND_API_KEY: string; // Stored as secret in wrangler
  RESEND_FROM: string;
}

// --- Helpers ---
const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };

async function parseExcel(buffer: ArrayBuffer): Promise<QuestionnaireQuestion[]> {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Empty Excel file');
  
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);
  return rows.map((row, i) => ({
    id: String(row.id || row.ID || `q_${i}`),
    question: String(row.question || row.Question || row['Security Question'] || ''),
    category: String(row.category || row.Category || '')
  })).filter(q => q.question.length > 5);
}

async function searchKB(kv: KVNamespace, questions: QuestionnaireQuestion[]): Promise<Map<string, KBEntry>> {
  const results = new Map<string, KBEntry>();
  // Simple hash-based lookup for MVP. In prod, use vector embeddings.
  const keys = await kv.list({ prefix: 'kb:' });
  const kbEntries = new Map<string, KBEntry>();
  
  // Batch fetch all KB entries (optimize later with vector search)
  for (const key of keys.keys) {
    const val = await kv.get<KBEntry>(key.name, 'json');
    if (val) kbEntries.set(key.name.replace('kb:', ''), val);
  }

  // Naive keyword matching for MVP
  for (const q of questions) {
    const qLower = q.question.toLowerCase();
    let bestMatch: KBEntry | null = null;
    let bestScore = 0;

    for (const [key, entry] of kbEntries) {
      const keyLower = key.toLowerCase();
      // Simple token overlap score
      const tokens = qLower.split(/\s+/).filter(t => t.length > 3);
      const score = tokens.filter(t => keyLower.includes(t)).length / tokens.length;
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = entry;
      }
    }
    if (bestMatch) results.set(q.id, bestMatch);
  }
  return results;
}

async function callLLM(env: Env, questions: QuestionnaireQuestion[], kbMatches: Map<string, KBEntry>): Promise<LLMResponse> {
  const prompt = `You are ShieldFill, an AI security questionnaire assistant.
Given a list of security/compliance questions and any matching knowledge base entries, provide answers.
Return ONLY valid JSON matching this schema:
{"answers": [{"id": "question_id", "answer": "string", "confidence": "high|medium|low", "source": "KB match or 'AI generated'"}]}

Rules:
- If KB match exists, use it as primary source, confidence=high
- If no KB match but you know the standard answer (SOC2/HIPAA/ISO27001), answer with confidence=medium
- If uncertain, confidence=low and answer="REQUIRES HUMAN REVIEW"
- NEVER fabricate compliance claims

Questions:
${JSON.stringify(questions)}

KB Matches:
${JSON.stringify(Object.fromEntries(kbMatches))}`;

  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) throw new Error(`LLM API error: ${res.status}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(data.choices[0].message.content) as LLMResponse;
}

function buildOutputExcel(questions: QuestionnaireQuestion[], llmAnswers: LLMResponse): Uint8Array {
  const rows = questions.map(q => {
    const ans = llmAnswers.answers.find(a => a.id === q.id);
    return {
      ID: q.id,
      Question: q.question,
      Category: q.category || '',
      Answer: ans?.answer || 'PENDING',
      Confidence: ans?.confidence || 'none',
      Source: ans?.source || ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ShieldFill Results');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

async function sendEmail(env: Env, to: string, attachment: Uint8Array, filename: string) {
  const b64 = btoa(String.fromCharCode(...attachment));
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject: `ShieldFill: Completed Questionnaire (${filename})`,
      text: 'Your AI-completed security questionnaire is attached. Please review low-confidence answers before submission.',
      attachments: [{ filename, content: b64, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
    })
  });
}

// --- Main Handler ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    
    const url = new URL(request.url);
    
    try {
      // POST /api/upload - Process questionnaire
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        const formData = await request.formData();
        const fileRaw = formData.get('file');
        const email = formData.get('email') as string;
        // CF Workers: formData.get() returns string | File | null
        // Use duck-typing check since instanceof File may not resolve in all worker runtimes
        if (!fileRaw || typeof fileRaw === 'string' || !('arrayBuffer' in fileRaw)) {
          return new Response(JSON.stringify({ error: 'Invalid file upload' }), { status: 400, headers: jsonHeaders });
        }
        const file = fileRaw as unknown as File;
        if (!file || !email) return new Response(JSON.stringify({ error: 'Missing file or email' }), { status: 400, headers: jsonHeaders });

        const buffer = await file.arrayBuffer();
        const questions = await parseExcel(buffer);
        if (questions.length === 0) return new Response(JSON.stringify({ error: 'No valid questions found' }), { status: 400, headers: jsonHeaders });

        const kbMatches = await searchKB(env.SHIELDFILL_KV, questions);
        const llmResults = await callLLM(env, questions, kbMatches);
        const output = buildOutputExcel(questions, llmResults);
        
        await sendEmail(env, email, output, file.name.replace('.xlsx', '_shieldfill.xlsx'));
        return new Response(JSON.stringify({ success: true, questions_processed: questions.length, kb_hits: kbMatches.size }), { headers: jsonHeaders });
      }

      // POST /api/kb/seed - Add KB entry
      if (url.pathname === '/api/kb/seed' && request.method === 'POST') {
        const { question, answer, source } = await request.json() as { question: string; answer: string; source: string };
        if (!question || !answer) return new Response(JSON.stringify({ error: 'Missing question or answer' }), { status: 400, headers: jsonHeaders });
        
        const key = `kb:${question.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 100)}`;
        await env.SHIELDFILL_KV.put(key, JSON.stringify({ answer, source, updatedAt: new Date().toISOString() }));
        return new Response(JSON.stringify({ success: true, key }), { headers: jsonHeaders });
      }

      // GET /health
      if (url.pathname === '/health') return new Response(JSON.stringify({ status: 'ok', model: env.LLM_MODEL }), { headers: jsonHeaders });

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: jsonHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), { status: 500, headers: jsonHeaders });
    }
  }
};
