// ShieldFill API — Full pipeline as Pages Function (bypasses workers.dev DNS)
export const onRequest: PagesFunction = async (context) => {
  const { request, params, env } = context;
  const path = Array.isArray(params.path) ? params.path.join('/') : params.path || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  // Health check
  if (path === 'health' && request.method === 'GET') {
    return new Response(JSON.stringify({ status: 'ok', model: env.LLM_MODEL || 'qwen-3.7-plus', backend: 'pages-function' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // KB Seed endpoint
  if (path === 'kb/seed' && request.method === 'POST') {
    try {
      const { question, answer, source } = await request.json() as any;
      if (!question || !answer) {
        return new Response(JSON.stringify({ error: 'Missing question or answer' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      const key = `kb:${question.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 100)}`;
      // @ts-ignore - KV binding from Pages project settings
      await env.SHIELDFILL_KV.put(key, JSON.stringify({ answer, source, updatedAt: new Date().toISOString() }));
      return new Response(JSON.stringify({ success: true, key }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // Upload endpoint
  if (path === 'upload' && request.method === 'POST') {
    try {
      const formData = await request.formData();
      const fileRaw = formData.get('file');
      const email = formData.get('email') as string;

      if (!fileRaw || typeof fileRaw === 'string' || !('arrayBuffer' in fileRaw)) {
        return new Response(JSON.stringify({ error: 'Invalid file upload' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (!email) {
        return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const file = fileRaw as unknown as File;
      const buffer = await file.arrayBuffer();

      // Dynamic import xlsx from CDN
      const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');

      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('Empty Excel file');

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);
      const questions = rows.map((row: any, i: number) => ({
        id: String(row.id || row.ID || `q_${i}`),
        question: String(row.question || row.Question || row['Security Question'] || ''),
        category: String(row.category || row.Category || '')
      })).filter((q: any) => q.question.length > 5);

      if (questions.length === 0) {
        return new Response(JSON.stringify({ error: 'No valid questions found in spreadsheet' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Search KB
      // @ts-ignore
      const kbKeys = await env.SHIELDFILL_KV.list({ prefix: 'kb:', limit: 1000 });
      const kbEntries = new Map<string, any>();
      for (const k of kbKeys.keys) {
        const val = await env.SHIELDFILL_KV.get(k.name, 'json');
        if (val) kbEntries.set(k.name.replace('kb:', ''), val);
      }

      const kbMatches = new Map<string, any>();
      for (const q of questions) {
        const qLower = q.question.toLowerCase();
        let bestMatch: any = null;
        let bestScore = 0;
        for (const [key, entry] of kbEntries) {
          const tokens = qLower.split(/\s+/).filter((t: string) => t.length > 3);
          const score = tokens.filter((t: string) => key.toLowerCase().includes(t)).length / Math.max(tokens.length, 1);
          if (score > bestScore && score > 0.3) {
            bestScore = score;
            bestMatch = entry;
          }
        }
        if (bestMatch) kbMatches.set(q.id, bestMatch);
      }

      // Call LLM
      const llmPrompt = `You are ShieldFill, an AI security questionnaire assistant.
Given questions and KB matches, provide answers as JSON: {"answers": [{"id", "answer", "confidence": "high|medium|low", "source"}]}
Rules: KB match=high confidence, standard compliance knowledge=medium, uncertain=low+"REQUIRES HUMAN REVIEW". NEVER fabricate.
Questions: ${JSON.stringify(questions)}
KB Matches: ${JSON.stringify(Object.fromEntries(kbMatches))}`;

      const llmRes = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.LLM_API_KEY}` },
        body: JSON.stringify({
          model: env.LLM_MODEL || 'qwen-3.7-plus',
          messages: [{ role: 'user', content: llmPrompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      });

      if (!llmRes.ok) throw new Error(`LLM API error: ${llmRes.status}`);
      const llmData = await llmRes.json() as any;
      const llmAnswers = JSON.parse(llmData.choices[0].message.content);

      // Build output Excel
      const outRows = questions.map((q: any) => {
        const ans = llmAnswers.answers?.find((a: any) => a.id === q.id);
        return {
          ID: q.id,
          Question: q.question,
          Category: q.category || '',
          Answer: ans?.answer || 'PENDING',
          Confidence: ans?.confidence || 'none',
          Source: ans?.source || ''
        };
      });

      const ws = XLSX.utils.json_to_sheet(outRows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ShieldFill Results');
      const outputBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

      // Send email via Resend
      const b64 = btoa(String.fromCharCode(...new Uint8Array(outputBuf)));
      const outFilename = file.name.replace('.xlsx', '_shieldfill.xlsx');

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.RESEND_FROM || 'shieldfill@edgeiqlabs.com',
          to: [email],
          subject: `ShieldFill: Completed Questionnaire (${outFilename})`,
          text: `Your AI-completed security questionnaire is attached.\n\nProcessed: ${questions.length} questions\nKB matches: ${kbMatches.size}\n\nPlease review low-confidence answers before submission.`,
          attachments: [{ filename: outFilename, content: b64, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
        })
      });

      return new Response(JSON.stringify({
        success: true,
        questions_processed: questions.length,
        kb_hits: kbMatches.size,
        message: `Completed questionnaire sent to ${email}`
      }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found', available: ['GET /health', 'POST /upload', 'POST /kb/seed'] }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
};
