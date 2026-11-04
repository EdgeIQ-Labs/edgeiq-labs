/**
 * EdgeIQ Inbox Triage - Stripe & Usage Helpers
 */

export async function recordUsage(env, customerId, eventType, metadata = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, customer_id, event_type, quantity, metadata, created_at)
       VALUES (?, ?, ?, 1, ?, datetime('now'))`
    ).bind(crypto.randomUUID(), customerId, eventType, JSON.stringify(metadata)).run();
  } catch (err) {
    console.error('Usage recording failed:', err.message);
  }
}

export async function checkSubscription(env, customerId) {
  const customer = await env.DB.prepare(
    'SELECT plan, status, emails_triaged, monthly_limit FROM customers WHERE id = ?'
  ).bind(customerId).first();

  if (!customer) return { valid: false, reason: 'not_found' };
  if (customer.status !== 'active' && customer.status !== 'trial') return { valid: false, reason: customer.status };
  if (customer.plan === 'starter' && customer.emails_triaged >= customer.monthly_limit) {
    return { valid: false, reason: 'limit_exceeded', triaged: customer.emails_triaged, limit: customer.monthly_limit };
  }

  return { valid: true, plan: customer.plan, triaged: customer.emails_triaged, limit: customer.monthly_limit };
}

export async function resetMonthlyUsage(env) {
  // Called by cron trigger on 1st of each month
  await env.DB.prepare('UPDATE customers SET emails_triaged = 0, updated_at = datetime("now")').run();
  console.log('Monthly usage counters reset');
}
