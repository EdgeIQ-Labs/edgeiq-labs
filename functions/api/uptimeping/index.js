const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  return new Response(JSON.stringify({
    service: 'UptimePing',
    description: 'Website uptime monitoring with email alerts',
    price: '$1/mo',
    features: ['5-minute checks', 'Response time tracking', 'Email alerts on downtime', 'Up to 25 monitors', '99.9% check reliability'],
    endpoints: {
      check: 'POST /api/uptimeping/check',
      monitors: 'GET/POST/DELETE /api/uptimeping/monitors',
      webhook: 'POST /api/uptimeping/webhook',
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
