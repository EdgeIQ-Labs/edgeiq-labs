/**
 * Compliance Report Download
 * GET /api/compliance-report/download?id=REPORT_ID
 * Returns stored HTML report for printing/saving as PDF
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing id parameter' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const html = await env.PULSE_KV.get(`compliance-report:${id}:html`);
  if (!html) {
    return new Response(JSON.stringify({ error: 'Report not found or expired' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="edgeiq-compliance-report-${id}.html"`,
      'Cache-Control': 'private, max-age=3600'
    }
  });
}
