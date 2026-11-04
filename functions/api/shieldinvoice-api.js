/**
 * shieldinvoice Dashboard API
 * GET /api/shieldinvoice-api?action=stats|invoices|reports|etc
 * Authenticates via API key, returns real data from KV
 */
export async function onRequest(context) {
  const { request, env } = context;
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'stats';
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = authHeader.replace('Bearer ', '');
  
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const kv = env.SHIELDINVOICE_KV || env.KV;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Validate API key
  const keyData = await kv.get('SHIELDINVOICE_apikey:' + apiKey, { type: 'json' });
  if (!keyData) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  const customerKey = 'SHIELDINVOICE_customer:' + keyData.email;
  const customer = await kv.get(customerKey, { type: 'json' });
  
  if (!customer) {
    return new Response(JSON.stringify({ error: 'Customer not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  // Return data based on action
  let responseData = {};
  
  switch (action) {
    case 'stats':
      responseData = {
        plan: customer.plan,
        status: customer.status,
        memberSince: customer.createdAt,
        usage: customer.usage || {},
      };
      break;
    case 'account':
      responseData = {
        email: keyData.email,
        plan: customer.plan,
        status: customer.status,
        apiKey: apiKey.substring(0, 10) + '...',
        subscriptionId: customer.subscriptionId,
      };
      break;
    default:
      responseData = { message: 'Action not implemented yet', action };
  }

  return new Response(JSON.stringify(responseData), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
