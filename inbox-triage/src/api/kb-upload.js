/**
 * EdgeIQ Inbox Triage - KB Document Upload
 * Accepts PDF/text docs, chunks them, stores in R2 + D1
 */

export async function handleKBUpload(request, env, customerId) {
  const formData = await request.formData();
  const file = formData.get('file');
  
  if (!file) {
    return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400 });
  }

  const docId = crypto.randomUUID();
  const storageKey = `${customerId}/${docId}/${file.name}`;
  
  // Upload to R2
  await env.KB_BUCKET.put(storageKey, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

  // Read text content for chunking (MVP: simple text split)
  const text = await file.text();
  const chunks = chunkText(text, 500); // ~500 chars per chunk

  // Store document metadata
  await env.DB.prepare(
    `INSERT INTO kb_documents (id, customer_id, filename, mime_type, size_bytes, storage_key, chunk_count, indexed_at, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(docId, customerId, file.name, file.type, file.size, storageKey, chunks.length).run();

  // Store chunks
  for (let i = 0; i < chunks.length; i++) {
    await env.DB.prepare(
      `INSERT INTO kb_chunks (id, document_id, customer_id, chunk_index, text_content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(crypto.randomUUID(), docId, customerId, i, chunks[i], Math.ceil(chunks[i].length / 4)).run();
  }

  return new Response(JSON.stringify({ 
    ok: true, 
    docId, 
    chunks: chunks.length,
    filename: file.name 
  }), { headers: { 'Content-Type': 'application/json' } });
}

function chunkText(text, maxChars) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';
  
  for (const para of paragraphs) {
    if ((current + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  
  return chunks.filter(c => c.length > 20); // Skip tiny fragments
}
