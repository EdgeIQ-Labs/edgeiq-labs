/**
 * Customer provisioning — creates accounts, generates API keys, stores in KV
 */

// Generate a secure API key
export function generateApiKey(prefix = 'eq') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = prefix + '_live_';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  for (const b of bytes) key += chars[b % chars.length];
  return key;
}

// Service configuration map
export const SERVICE_CONFIG = {
  shieldinvoice: {
    name: 'ShieldInvoice',
    dashboardPath: '/shieldinvoice/dashboard/',
    kvPrefix: 'SHIELDINVOICE_',
    priceToPlan: {
      'price_1UY8fpRC1NZ20yDTl4UJg8YG': 'pro',
    },
  },
  shieldverify: {
    name: 'ShieldVerify',
    dashboardPath: '/shieldverify/dashboard/',
    kvPrefix: 'SHIELDVERIFY_',
    priceToPlan: {
      'price_1UY8fpRC1NZ20yDTH0BCnBuR': 'starter',
    },
  },
  shieldbuild: {
    name: 'ShieldBuild',
    dashboardPath: '/shieldbuild/dashboard/',
    kvPrefix: 'SHIELDBUILD_',
    priceToPlan: {
      'price_1UY8fqRC1NZ20yDTqa4bAi20': 'starter',
    },
  },
  compliance: {
    name: 'Compliance Shield',
    dashboardPath: '/compliance/dashboard/',
    kvPrefix: 'COMPLIANCE_',
    priceToPlan: {
      'price_1UWegSRC1NZ20yDT6bCl1jAp': 'starter',
      'price_1UWegSRC1NZ20yDTZdPzn7Tn': 'pro',
    },
  },
  shieldfill: {
    name: 'ShieldFill',
    dashboardPath: '/shieldfill/dashboard/',
    kvPrefix: 'SHIELDFILL_',
    priceToPlan: {
      'price_1UWgF5RC1NZ20yDTyUaJZ5Uk': 'starter',
      'price_1UWgF6RC1NZ20yDTfpN09XAU': 'pro',
    },
  },
  'vendor-risk': {
    name: 'Vendor Risk',
    dashboardPath: '/vendor-risk/dashboard/',
    kvPrefix: 'VENDORRISK_',
    priceToPlan: {
      'price_1UWye4RC1NZ20yDTb61AV8dy': 'starter',
      'price_1UWye5RC1NZ20yDTw9l6DaCe': 'pro',
    },
  },
};

// Detect which service a subscription belongs to based on price ID
export function detectService(priceId) {
  for (const [slug, config] of Object.entries(SERVICE_CONFIG)) {
    if (config.priceToPlan[priceId]) {
      return { slug, ...config, plan: config.priceToPlan[priceId] };
    }
  }
  return null;
}

// Provision a new customer in KV
export async function provisionCustomer(kv, serviceSlug, { email, customerId, subscriptionId, plan, apiKey }) {
  const config = SERVICE_CONFIG[serviceSlug];
  if (!config) throw new Error(`Unknown service: ${serviceSlug}`);
  
  const customerData = {
    email,
    stripeCustomerId: customerId,
    subscriptionId,
    plan,
    apiKey,
    createdAt: new Date().toISOString(),
    status: 'active',
    usage: {},
  };
  
  // Store by email (primary lookup)
  await kv.put(`${config.kvPrefix}customer:${email}`, JSON.stringify(customerData));
  
  // Store by Stripe customer ID (webhook lookup)
  await kv.put(`${config.kvPrefix}stripe:${customerId}`, JSON.stringify({ email, serviceSlug }));
  
  // Store by API key (auth lookup)
  await kv.put(`${config.kvPrefix}apikey:${apiKey}`, JSON.stringify({ email, serviceSlug }));
  
  return customerData;
}
