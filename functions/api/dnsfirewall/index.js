/**
 * EdgeIQ DNS Firewall — Root info endpoint
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response(JSON.stringify({
    service: 'DNS Firewall',
    description: 'Managed DNS filtering with threat intelligence',
    tiers: {
      free: { price: '$0/mo', devices: 1, blocklists: 3, features: ['Basic ad blocking'] },
      personal: { price: '$5/mo', devices: 10, blocklists: 10, features: ['Malware/phishing protection', 'Custom allowlists', 'Weekly digest'] },
      business: { price: '$19/mo', devices: 'Unlimited', blocklists: 'Unlimited', features: ['Real-time alerts', 'Compliance reporting', 'Priority support'] },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
