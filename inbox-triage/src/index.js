/**
 * EdgeIQ Inbox Triage - Main Worker Entry Point
 */

import { handleWebhook } from './api/webhook.js';
import { handleDrafts } from './api/drafts.js';
import { handleClassify } from './api/classify.js';
import { handleKBUpload } from './api/kb-upload.js';
import { handleStripeWebhook } from './api/stripe-webhook.js';
import { resetMonthlyUsage } from './lib/stripe.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // Inbound email webhook from Mailflare
      if (path === '/webhook/email' && request.method === 'POST') {
        return addCors(await handleWebhook(request, env));
      }

      // Stripe subscription webhook
      if (path === '/webhook/stripe' && request.method === 'POST') {
        return addCors(await handleStripeWebhook(request, env));
      }

      // Auth-gated API routes
      if (path.startsWith('/api/')) {
        const authHeader = request.headers.get('Authorization');
        let customerId = null;

        // Skip auth for checkout redirect (public)
        if (path.startsWith('/api/inbox-triage/checkout')) {
          return addCors(await handleCheckoutRedirect(request, env));
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return addCors(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
        }

        // Resolve customer from API key (stored in KV or DB)
        const token = authHeader.replace('Bearer ', '');
        const custData = await env.CACHE_KV.get(`apikey:${token}`);
        if (custData) {
          customerId = custData;
        } else {
          // Fallback: look up by email in DB
          const customer = await env.DB.prepare('SELECT id FROM customers WHERE email = ?').bind(token).first();
          if (customer) customerId = customer.id;
        }

        if (!customerId) {
          return addCors(new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
        }

        // Route to handlers
        if (path === '/api/drafts' || path.match(/\/api\/drafts\//)) {
          return addCors(await handleDrafts(path, request, env, customerId));
        }
        if (path === '/api/classify') {
          return addCors(await handleClassify(path, request, env, customerId));
        }
        if (path === '/api/kb/upload') {
          return addCors(await handleKBUpload(request, env, customerId));
        }
        if (path === '/api/stats') {
          return addCors(await handleStats(env, customerId));
        }

        return addCors(new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }

      // Health check
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'inbox-triage', version: '0.1.0' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // Landing page
      if (path === '/' || path === '/inbox-triage' || path === '/inbox-triage/') {
        return new Response('Inbox Triage by EdgeIQ Labs — Redirect to landing page', {
          status: 302,
          headers: { 'Location': '/inbox-triage/', ...corsHeaders() }
        });
      }

      // Dashboard SPA
      if (path.startsWith('/dashboard')) {
        return new Response('Inbox Triage Dashboard — Serve via CF Pages', { headers: corsHeaders() });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders() });

    } catch (err) {
      console.error('Worker error:', err.stack || err.message);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(resetMonthlyUsage(env));
  }
};

async function handleStats(env, customerId) {
  const total = await env.DB.prepare('SELECT COUNT(*) as count FROM classifications WHERE customer_id = ?').bind(customerId).first();
  const pending = await env.DB.prepare("SELECT COUNT(*) as count FROM drafts WHERE customer_id = ? AND status = 'pending'").bind(customerId).first();
  const p0 = await env.DB.prepare("SELECT COUNT(*) as count FROM classifications WHERE customer_id = ? AND priority = 'P0'").bind(customerId).first();
  const avgConf = await env.DB.prepare('SELECT AVG(confidence) as avg FROM classifications WHERE customer_id = ?').bind(customerId).first();
  const recent = await env.DB.prepare('SELECT sender_email, subject, category, priority, classified_at FROM classifications WHERE customer_id = ? ORDER BY classified_at DESC LIMIT 10').bind(customerId).all();

  return new Response(JSON.stringify({
    stats: {
      total: total?.count || 0,
      pendingDrafts: pending?.count || 0,
      p0Count: p0?.count || 0,
      avgConfidence: avgConf?.avg || 0
    },
    recent: recent.results || []
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleCheckoutRedirect(request, env) {
  const url = new URL(request.url);
  const plan = url.searchParams.get('plan') || 'starter';
  const priceMap = { starter: 'price_inbox_starter', pro: 'price_inbox_pro' };

  if (!env.STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Checkout not configured' }), { status: 501 });
  }

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': priceMap[plan] || priceMap.starter,
        'line_items[0][quantity]': '1',
        success_url: `${url.origin}/dashboard/?checkout=success`,
        cancel_url: `${url.origin}/inbox-triage/?checkout=cancelled`,
        'metadata[plan]': plan
      }).toString()
    });

    const session = await response.json();
    if (session.url) {
      return new Response(null, { status: 302, headers: { 'Location': session.url } });
    }
    return new Response(JSON.stringify({ error: 'Failed to create checkout' }), { status: 500 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function addCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
