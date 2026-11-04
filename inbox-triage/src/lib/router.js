/**
 * EdgeIQ Inbox Triage - Email Router
 * Routes classified emails based on customer rules + defaults
 */

export async function routeEmail(email, classification, mailbox, env) {
  // Load customer routing rules
  const rules = await env.DB.prepare(
    'SELECT * FROM routing_rules WHERE customer_id = ? AND is_active = 1 ORDER BY priority_order DESC'
  ).bind(mailbox.customer_id).all();

  const ruleList = rules.results || [];

  // Check custom rules first
  for (const rule of ruleList) {
    if (matchesRule(email, classification, rule)) {
      await executeAction(rule.action, rule.action_value, email, classification, mailbox, env);
      return { routed: true, rule: rule.id, action: rule.action };
    }
  }

  // Default routing by category
  const defaultRoutes = {
    spam: 'archive',
    newsletter: 'tag_newsletter',
    urgent: 'alert_p0',
    support: 'route_support',
    sales: 'route_sales',
    internal: 'tag_internal',
    other: 'inbox'
  };

  const action = defaultRoutes[classification.category] || 'inbox';
  await executeAction(action, null, email, classification, mailbox, env);

  return { routed: true, rule: 'default', action };
}

function matchesRule(email, classification, rule) {
  switch (rule.rule_type) {
    case 'category':
      return classification.category === rule.rule_value;
    case 'priority':
      return classification.priority === rule.rule_value;
    case 'sender':
      return (email.from || '').toLowerCase().includes(rule.rule_value.toLowerCase());
    case 'keyword':
      const combined = `${email.subject || ''} ${email.body || ''}`.toLowerCase();
      return combined.includes(rule.rule_value.toLowerCase());
    default:
      return false;
  }
}

async function executeAction(action, actionValue, email, classification, mailbox, env) {
  switch (action) {
    case 'archive':
      // Mark as archived in Mailflare via API
      console.log(`Archiving email ${email.messageId} for customer ${mailbox.customer_id}`);
      break;

    case 'tag_newsletter':
    case 'tag_internal':
      // Apply tag in Mailflare
      console.log(`Tagging email ${email.messageId}: ${action.replace('tag_', '')}`);
      break;

    case 'alert_p0':
      // Handled separately in webhook.js
      break;

    case 'route_support':
    case 'route_sales':
      // Move to appropriate mailbox folder
      console.log(`Routing ${email.messageId} to ${action.replace('route_', '')} folder`);
      break;

    case 'route_to_mailbox':
      if (actionValue) {
        console.log(`Routing ${email.messageId} to mailbox ${actionValue}`);
      }
      break;

    case 'auto_reply':
      // Will be handled by draft engine
      break;

    case 'inbox':
    default:
      // Leave in inbox, no action needed
      break;
  }
}
