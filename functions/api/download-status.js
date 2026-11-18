/**
 * Download Status Check
 * GET /api/download-status?session_id=<stripe_session_id>
 * 
 * Returns download URL if purchase record exists (webhook completed).
 * Used by success page to poll for readiness.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');

  if (!sessionId) {
    return Response.json({ error: 'Missing session_id' }, { status: 400 });
  }

  const recordJson = await env.PULSE_KV.get(`digital:purchase:${sessionId}`);
  if (!recordJson) {
    return Response.json({ ready: false });
  }

  const record = JSON.parse(recordJson);
  return Response.json({
    ready: true,
    downloadUrl: `/api/download?token=${record.downloadToken}`,
    productName: record.productName,
    downloadsRemaining: record.downloadsRemaining,
  });
}
