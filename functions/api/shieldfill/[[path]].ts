export const onRequest: PagesFunction = async (context) => {
  const { request, params } = context;
  const path = Array.isArray(params.path) ? params.path.join('/') : params.path || '';
  const url = new URL(request.url);
  
  // Proxy to the shieldfill worker
  const targetUrl = `https://shieldfill.edgeiqlabs.workers.dev/${path}${url.search}`;
  
  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });
    
    // Clone and add CORS headers for browser access
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return newResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: 'ShieldFill service unavailable', detail: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Handle preflight
export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
};
