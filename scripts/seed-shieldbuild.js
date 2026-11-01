#!/usr/bin/env node
// ShieldBuild KV Seed Script
// Run: node scripts/seed-shieldbuild.js
// Requires: SHIELDBUILD_KV binding or WRANGLER_API_TOKEN env var

const DEMO_USER = {
  id: 'demo-user-001',
  email: 'demo@edgeiqlabs.com',
  name: 'Demo Safety Manager',
  password: 'DemoBuild2026!',
  tier: 'builder',
  companyName: 'EdgeIQ Demo Construction',
  createdAt: new Date().toISOString(),
};

const JOB_SITES = [
  {
    id: 'site-001',
    userId: DEMO_USER.id,
    name: 'Riverside Medical Center Expansion',
    address: '1200 River Rd, Newark, NJ 07102',
    status: 'active',
    startDate: '2026-08-15',
    estimatedEnd: '2027-03-30',
    crewSize: 45,
  },
  {
    id: 'site-002',
    userId: DEMO_USER.id,
    name: 'Hudson Yards Parking Structure',
    address: '500 W 33rd St, New York, NY 10001',
    status: 'active',
    startDate: '2026-10-01',
    estimatedEnd: '2027-06-15',
    crewSize: 28,
  },
];

const INCIDENTS = [
  {
    id: 'inc-001',
    userId: DEMO_USER.id,
    siteId: 'site-001',
    type: 'near_miss',
    date: '2026-10-15',
    location: 'Floor 3 scaffolding',
    description: 'Worker nearly slipped on wet surface near scaffold access point. No injury occurred.',
    severity: 'medium',
    injuredPersons: [],
    witnesses: ['Mike Torres'],
    correctiveActions: 'Added non-slip mats and improved drainage at scaffold access points.',
    status: 'closed',
    createdAt: '2026-10-15T14:30:00Z',
    updatedAt: '2026-10-16T09:00:00Z',
  },
  {
    id: 'inc-002',
    userId: DEMO_USER.id,
    siteId: 'site-001',
    type: 'injury',
    date: '2026-10-22',
    location: 'Loading dock B',
    description: 'Worker sustained minor hand laceration while handling rebar without gloves.',
    severity: 'low',
    injuredPersons: [{ name: 'James Wilson', role: 'Laborer' }],
    witnesses: ['Sarah Chen', 'Mike Torres'],
    correctiveActions: 'Mandatory PPE refresher training scheduled. Glove stations added at all material handling areas.',
    daysAwayFromWork: 0,
    daysOfJobRestriction: 2,
    status: 'closed',
    createdAt: '2026-10-22T10:15:00Z',
    updatedAt: '2026-10-24T16:00:00Z',
  },
  {
    id: 'inc-003',
    userId: DEMO_USER.id,
    siteId: 'site-002',
    type: 'property_damage',
    date: '2026-10-28',
    location: 'Foundation excavation area',
    description: 'Excavator bucket struck underground utility line during trenching. Gas line damaged, area evacuated.',
    severity: 'high',
    injuredPersons: [],
    witnesses: ['Carlos Ruiz'],
    correctiveActions: 'Utility locate verification protocol updated. All operators re-briefed on 811 requirements.',
    status: 'investigating',
    createdAt: '2026-10-28T08:45:00Z',
    updatedAt: '2026-10-28T08:45:00Z',
  },
];

const CALENDAR_ENTRIES = [
  { date: '2026-11-10', type: 'inspection', title: 'OSHA Scaffolding Inspection — Riverside', siteId: 'site-001' },
  { date: '2026-11-18', type: 'training', title: 'Fall Protection Refresher Training', siteId: null },
  { date: '2026-12-01', type: 'permit', title: 'NYC DOB Permit Renewal — Hudson Yards', siteId: 'site-002' },
  { date: '2026-12-15', type: 'training', title: 'First Aid/CPR Certification Expiry', siteId: null },
  { date: '2027-01-05', type: 'inspection', title: 'Annual Fire Safety Equipment Inspection', siteId: 'site-001' },
];

async function seed() {
  // This script is meant to be adapted for wrangler kv:key put or run via CF Workers API
  console.log('=== ShieldBuild KV Seed Data ===\n');
  
  const entries = [];
  
  // User
  entries.push({ key: `users:${DEMO_USER.email}`, value: JSON.stringify(DEMO_USER) });
  
  // Job sites
  for (const site of JOB_SITES) {
    entries.push({ key: `jobsites:${DEMO_USER.id}:${site.id}`, value: JSON.stringify(site) });
  }
  
  // Incidents
  for (const inc of INCIDENTS) {
    entries.push({ key: `incidents:${DEMO_USER.id}:${inc.id}`, value: JSON.stringify(inc) });
  }
  
  // Calendar
  entries.push({ key: `calendar:${DEMO_USER.id}`, value: JSON.stringify(CALENDAR_ENTRIES) });
  
  console.log(`Total KV entries to seed: ${entries.length}\n`);
  
  for (const entry of entries) {
    console.log(`PUT ${entry.key}`);
  }
  
  console.log('\n=== Wrangler Commands ===');
  console.log('# Run these commands after creating SHIELDBUILD_KV namespace:\n');
  
  for (const entry of entries) {
    const escaped = entry.value.replace(/'/g, "'\\''");
    console.log(`wrangler kv:key put --binding=SHIELDBUILD_KV '${entry.key}' '${escaped}'`);
  }
  
  // Also output as JSON for programmatic use
  const jsonPath = '/home/guy/repos/edgeiq-labs/scripts/shieldbuild-seed-data.json';
  const fs = await import('fs');
  fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2));
  console.log(`\nSeed data written to: ${jsonPath}`);
}

seed().catch(console.error);
