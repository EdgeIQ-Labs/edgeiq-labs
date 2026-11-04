export async function onRequest(context) {
  const { env } = context;
  const hasKey = !!env.STRIPE_SECRET_KEY;
  const keyPrefix = hasKey ? env.STRIPE_SECRET_KEY.substring(0, 7) + '...' : 'MISSING';
  return new Response(JSON.stringify({ hasStripeKey: hasKey, prefix: keyPrefix }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

