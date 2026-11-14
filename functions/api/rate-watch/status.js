// GET /api/rate-watch/status — returns current prime rate + last checked timestamp from KV
export async function onRequestGet(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300'
  };

  try {
    const kv = context.env.RATE_WATCH_KV;
    if (!kv) {
      return new Response(JSON.stringify({ error: 'KV not bound' }), { status: 500, headers });
    }

    const rateData = await kv.get('prime_rate_current', 'json');
    if (!rateData) {
      return new Response(JSON.stringify({
        rate: null,
        updated: null,
        message: 'No rate data yet — first cron check pending'
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({
      rate: rateData.rate,
      updated: rateData.updated_at || null,
      previous_rate: rateData.previous_rate || null,
      changed: rateData.previous_rate !== null && rateData.previous_rate !== rateData.rate
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
