// Seed demo data for ShieldVerify KV
// Run: node seed-shieldverify.js

const CF_ACCOUNT_ID = '632b16163d95a11698f8542b418ba236';
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!CF_API_TOKEN) { console.error('ERROR: Set CLOUDFLARE_API_TOKEN env var'); process.exit(1); }

// Find KV namespace ID
async function getKvNamespaceId() {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces`, {
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` }
  });
  const data = await res.json();
  const ns = data.result?.find(n => n.title === 'SHIELDVERIFY_KV');
  if (!ns) throw new Error('SHIELDVERIFY_KV namespace not found. Create it first.');
  return ns.id;
}

async function kvPut(namespaceId, key, value) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to put ${key}: ${res.status} ${text}`);
  } else {
    console.log(`✓ ${key}`);
  }
}

async function main() {
  const nsId = await getKvNamespaceId();
  console.log(`Using KV namespace: ${nsId}`);

  const demoUserId = 'demo-user-001';
  const demoEmail = 'demo@edgeiqlabs.com';

  // Demo user
  await kvPut(nsId, `users:${demoEmail}`, {
    id: demoUserId,
    email: demoEmail,
    name: 'Demo User',
    password: 'DemoPass123!',
    tier: 'pro',
    stripeCustomerId: 'cus_demo_001',
    subscriptionId: 'sub_demo_001',
    createdAt: new Date().toISOString(),
  });

  // Users index
  await kvPut(nsId, 'users:index', [
    { id: demoUserId, email: demoEmail, tier: 'pro' }
  ]);

  // 3 servers
  const servers = [
    { id: 'srv-001', userId: demoUserId, name: 'prod-db-primary', backupType: 'veeam', storagePath: '/backups/db', lastTestAt: null, lastTestStatus: null, createdAt: new Date().toISOString() },
    { id: 'srv-002', userId: demoUserId, name: 'file-server-nas', backupType: 'acronis', storagePath: '/mnt/backups', lastTestAt: null, lastTestStatus: null, createdAt: new Date().toISOString() },
    { id: 'srv-003', userId: demoUserId, name: 'app-cluster-s3', backupType: 's3', storagePath: 's3://company-backups/app', lastTestAt: null, lastTestStatus: null, createdAt: new Date().toISOString() },
  ];
  for (const s of servers) {
    await kvPut(nsId, `servers:${demoUserId}:${s.id}`, s);
  }

  // 5 test results
  const now = Date.now();
  const tests = [
    { id: 'test-001', userId: demoUserId, serverId: 'srv-001', backupType: 'veeam', storagePath: '/backups/db', status: 'passed', checksumMatch: true, expectedChecksum: 'sha256:a1b2c3d4e5f6', actualChecksum: 'sha256:a1b2c3d4e5f6', resilienceScore: 92, restoreTimeMs: 3200, fileSizeBytes: 850000000, verifiedAt: new Date(now - 86400000).toISOString(), createdAt: new Date(now - 86400000).toISOString(), notes: 'Restore completed successfully.' },
    { id: 'test-002', userId: demoUserId, serverId: 'srv-002', backupType: 'acronis', storagePath: '/mnt/backups', status: 'passed', checksumMatch: true, expectedChecksum: 'sha256:f6e5d4c3b2a1', actualChecksum: 'sha256:f6e5d4c3b2a1', resilienceScore: 88, restoreTimeMs: 4100, fileSizeBytes: 1200000000, verifiedAt: new Date(now - 172800000).toISOString(), createdAt: new Date(now - 172800000).toISOString(), notes: 'All checksums validated.' },
    { id: 'test-003', userId: demoUserId, serverId: 'srv-003', backupType: 's3', storagePath: 's3://company-backups/app', status: 'failed', checksumMatch: false, expectedChecksum: 'sha256:abcdef123456', actualChecksum: 'sha256:MISMATCH_xyz', resilienceScore: 35, restoreTimeMs: 5800, fileSizeBytes: 650000000, verifiedAt: new Date(now - 259200000).toISOString(), createdAt: new Date(now - 259200000).toISOString(), notes: 'Checksum mismatch detected.' },
    { id: 'test-004', userId: demoUserId, serverId: 'srv-001', backupType: 'veeam', storagePath: '/backups/db', status: 'passed', checksumMatch: true, expectedChecksum: 'sha256:112233445566', actualChecksum: 'sha256:112233445566', resilienceScore: 95, restoreTimeMs: 2900, fileSizeBytes: 870000000, verifiedAt: new Date(now - 345600000).toISOString(), createdAt: new Date(now - 345600000).toISOString(), notes: 'Weekly scheduled test passed.' },
    { id: 'test-005', userId: demoUserId, serverId: 'srv-002', backupType: 'acronis', storagePath: '/mnt/backups', status: 'passed', checksumMatch: true, expectedChecksum: 'sha256:aabbccddeeff', actualChecksum: 'sha256:aabbccddeeff', resilienceScore: 91, restoreTimeMs: 3800, fileSizeBytes: 1100000000, verifiedAt: new Date(now - 432000000).toISOString(), createdAt: new Date(now - 432000000).toISOString(), notes: 'Monthly audit test passed.' },
  ];
  for (const t of tests) {
    await kvPut(nsId, `tests:${demoUserId}:${t.id}`, t);
  }

  // Update server last test status
  servers[0].lastTestAt = tests[0].verifiedAt;
  servers[0].lastTestStatus = 'passed';
  servers[1].lastTestAt = tests[1].verifiedAt;
  servers[1].lastTestStatus = 'passed';
  servers[2].lastTestAt = tests[2].verifiedAt;
  servers[2].lastTestStatus = 'failed';
  for (const s of servers) {
    await kvPut(nsId, `servers:${demoUserId}:${s.id}`, s);
  }

  // 2 reports
  const reports = [
    { id: 'rpt-001', userId: demoUserId, name: 'SOC2 Type II — Backup Integrity Q4 2026', framework: 'SOC2', createdAt: new Date(now - 604800000).toISOString(), generatedBy: 'system' },
    { id: 'rpt-002', userId: demoUserId, name: 'HIPAA Backup Compliance Audit — Oct 2026', framework: 'HIPAA', createdAt: new Date(now - 1209600000).toISOString(), generatedBy: 'system' },
  ];
  for (const r of reports) {
    await kvPut(nsId, `reports:${demoUserId}:${r.id}`, r);
  }

  console.log('\n✅ Seed complete! Demo login: demo@edgeiqlabs.com / DemoPass123!');
}

main().catch(err => { console.error(err); process.exit(1); });
