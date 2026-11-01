// Seed ShieldInvoice KV with demo user and sample invoices
// Run: node scripts/seed-shieldinvoice.js
// Requires CLOUDFLARE_API_TOKEN in env or ~/.hermes/.env

const https = require('https');
const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = '632b16163d95a11698f8542b418ba236';
const KV_NAMESPACE_ID = '5106b3ec3d344bfe85c0d1938293edd8';

// Load token
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  const envPath = path.join(require('os').homedir(), '.hermes', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m);
  if (match) token = match[1].trim().replace(/^["']|["']$/g, '');
}
if (!token) { console.error('No CLOUDFLARE_API_TOKEN found'); process.exit(1); }

async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`KV PUT ${key}: ${res.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    req.write(typeof value === 'string' ? value : JSON.stringify(value));
    req.end();
  });
}

async function seed() {
  console.log('Seeding ShieldInvoice KV...');

  // Demo user
  const demoUser = {
    id: 'demo-user-001',
    email: 'demo@edgeiqlabs.com',
    name: 'Demo User',
    password: 'DemoInvoice2026!',
    tier: 'pro',
    createdAt: new Date().toISOString(),
  };
  await kvPut('users:demo@edgeiqlabs.com', JSON.stringify(demoUser));
  console.log('✓ Demo user created: demo@edgeiqlabs.com / DemoInvoice2026!');

  // Users index
  await kvPut('users:index', JSON.stringify([{ id: 'demo-user-001', email: 'demo@edgeiqlabs.com', tier: 'pro' }]));

  // Sample invoices
  const now = new Date();
  const samples = [
    {
      id: 'inv-sample-001',
      userId: 'demo-user-001',
      userEmail: 'demo@edgeiqlabs.com',
      fileName: 'acme-supply-inv-2024-0892.pdf',
      fileSize: 142000,
      extractedText: 'ACME SUPPLY CO. Invoice #2024-0892 Date: 2026-10-15 ...',
      data: {
        vendorName: 'Acme Supply Co.',
        invoiceNumber: '2024-0892',
        date: '2026-10-15',
        lineItems: [
          { description: 'Industrial Lubricant Case (12x)', quantity: 4, unitPrice: 89.50, amount: 358.00 },
          { description: 'Safety Goggles ANSI Z87.1', quantity: 20, unitPrice: 12.75, amount: 255.00 },
          { description: 'Nitrile Gloves Box (100ct)', quantity: 10, unitPrice: 18.90, amount: 189.00 },
        ],
        subtotal: 802.00,
        tax: 64.16,
        total: 866.16,
        poNumber: 'PO-2026-0441',
        confidenceScore: 0.97,
        anomalies: [],
      },
      processedAt: new Date(now - 86400000 * 2).toISOString(),
      status: 'completed',
    },
    {
      id: 'inv-sample-002',
      userId: 'demo-user-001',
      userEmail: 'demo@edgeiqlabs.com',
      fileName: 'techserve-maintenance-oct2026.pdf',
      fileSize: 98000,
      extractedText: 'TechServe Solutions Maintenance Agreement Oct 2026 ...',
      data: {
        vendorName: 'TechServe Solutions',
        invoiceNumber: 'TS-2026-11847',
        date: '2026-10-28',
        lineItems: [
          { description: 'Monthly IT Support Retainer', quantity: 1, unitPrice: 2500.00, amount: 2500.00 },
          { description: 'Emergency Server Recovery (Oct 12)', quantity: 1, unitPrice: 750.00, amount: 750.00 },
          { description: 'Firewall Firmware Update', quantity: 1, unitPrice: 350.00, amount: 350.00 },
        ],
        subtotal: 3600.00,
        tax: 0,
        total: 3600.00,
        poNumber: null,
        confidenceScore: 0.92,
        anomalies: ['Missing PO number for service invoice over $1,000', 'Round amount ($3,600.00) may warrant verification'],
      },
      processedAt: new Date(now - 86400000).toISOString(),
      status: 'completed',
    },
    {
      id: 'inv-sample-003',
      userId: 'demo-user-001',
      userEmail: 'demo@edgeiqlabs.com',
      fileName: 'global-logistics-freight-nov2026.pdf',
      fileSize: 215000,
      extractedText: 'GLOBAL LOGISTICS INC Freight Invoice GL-NOV-4421 ...',
      data: {
        vendorName: 'Global Logistics Inc.',
        invoiceNumber: 'GL-NOV-4421',
        date: '2026-11-01',
        lineItems: [
          { description: 'LTL Freight NYC → CHI Pallet #A-2291', quantity: 1, unitPrice: 1245.00, amount: 1245.00 },
          { description: 'Fuel Surcharge 18%', quantity: 1, unitPrice: 224.10, amount: 224.10 },
          { description: 'Liftgate Service', quantity: 1, unitPrice: 85.00, amount: 85.00 },
          { description: 'Inside Delivery', quantity: 1, unitPrice: 125.00, amount: 125.00 },
        ],
        subtotal: 1679.10,
        tax: 0,
        total: 1679.10,
        poNumber: 'PO-2026-0455',
        confidenceScore: 0.95,
        anomalies: [],
      },
      processedAt: new Date().toISOString(),
      status: 'completed',
    },
  ];

  const indexEntries = [];
  for (const inv of samples) {
    await kvPut(`invoices:${inv.userId}:${inv.id}`, JSON.stringify(inv));
    indexEntries.push({
      id: inv.id,
      fileName: inv.fileName,
      processedAt: inv.processedAt,
      vendorName: inv.data.vendorName,
      total: inv.data.total,
    });
    console.log(`✓ Invoice seeded: ${inv.data.vendorName} — $${inv.data.total.toFixed(2)}`);
  }

  // Sort newest first
  indexEntries.sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));
  await kvPut('index:demo-user-001', JSON.stringify(indexEntries));

  // Stats
  const stats = {
    totalProcessed: 3,
    totalAmount: 866.16 + 3600.00 + 1679.10,
    anomalyCount: 2,
    byMonth: { '2026-10': 2, '2026-11': 1 },
  };
  await kvPut('stats:demo-user-001', JSON.stringify(stats));
  console.log('✓ Stats seeded');

  console.log('\nSeed complete. Login: demo@edgeiqlabs.com / DemoInvoice2026!');
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1); });
