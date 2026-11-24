/**
 * EdgeIQ Labs — Checkout Bot Guard Middleware
 *
 * Blocks non-browser GET/HEAD requests to /api/*-checkout endpoints.
 * Crawlers, link previews, and bots were creating thousands of phantom
 * Stripe checkout sessions that inflated abandonment metrics and burned
 * rate limits. Real users clicking links in browsers are unaffected.
 *
 * POST-based checkout flows (form submissions) are never touched.
 */

const CHECKOUT_PATH = /\/api\/[a-z0-9-]*checkout(?:\/|$)/i;

const BOT_UA = /bot|crawl|spider|slackbot|twitterbot|facebookexternalhit|linkedinbot|whatsapp|telegram|preview|curl|wget|python-requests|node-fetch|axios|go-http-client|postman|httpclient|java|okhttp/i;

function hasBrowserIntent(request) {
  const h = request.headers;
  const ua = h.get('user-agent') || '';
  if (BOT_UA.test(ua)) return false;

  const accept = h.get('accept') || '';
  if (!accept.includes('text/html')) return false;

  const mode = h.get('sec-fetch-mode');
  if (mode && mode !== 'navigate') return false;

  const dest = h.get('sec-fetch-dest');
  if (dest && !['document', 'iframe'].includes(dest)) return false;

  return true;
}

export async function onRequest(context) {
  const { request, next } = context;
  const method = request.method;

  // Only gate GET/HEAD — POST checkouts from forms must pass untouched
  if ((method === 'GET' || method === 'HEAD') && CHECKOUT_PATH.test(new URL(request.url).pathname)) {
    if (!hasBrowserIntent(request)) {
      return new Response('Forbidden', {
        status: 403,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  return next();
}
