'use strict';

const express = require('express');
const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ─── Config ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;
const SECRET = process.env.PHISHSIM_SECRET || 'changeme';
const DATA_DIR = process.env.DATA_DIR || '/data';
const BASE_PORT = parseInt(process.env.BASE_PORT || '8200', 10);
const MAX_INSTANCES = parseInt(process.env.MAX_INSTANCES || '50', 10);
const GOPHISH_IMAGE = process.env.GOPHISH_IMAGE || 'gophish/gophish:latest';
const PUBLIC_IP = process.env.PUBLIC_IP || '100.33.233.11';
const TRAEFIK_NETWORK = process.env.TRAEFIK_NETWORK || 't3_proxy';

// Instance registry file
const REGISTRY_PATH = path.join(DATA_DIR, 'instances.json');

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[registry] Load error:', e.message);
  }
  return {};
}

function saveRegistry(registry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// Auth middleware — accepts Bearer token OR X-Provision-Secret header
// (Cloudflare strips Authorization headers on proxied DNS records)
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const bearerToken = auth.replace(/^Bearer\s+/i, '');
  const headerSecret = req.headers['x-provision-secret'] || '';
  if (bearerToken !== SECRET && headerSecret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Health ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const registry = loadRegistry();
  res.json({
    status: 'ok',
    service: 'phishsim-manager',
    instances: Object.keys(registry).length,
    ts: new Date().toISOString()
  });
});

// ─── Find next available port ──────────────────────────────────────────
async function findNextPort() {
  const containers = await docker.listContainers({ all: true });
  const usedPorts = new Set();
  for (const c of containers) {
    for (const p of (c.Ports || [])) {
      if (p.PublicPort) usedPorts.add(p.PublicPort);
    }
  }
  // Also check registry
  const registry = loadRegistry();
  for (const inst of Object.values(registry)) {
    if (inst.port) usedPorts.add(inst.port);
  }
  let port = BASE_PORT;
  while (usedPorts.has(port)) port++;
  if (port >= BASE_PORT + MAX_INSTANCES) {
    throw new Error('No available ports');
  }
  return port;
}

// ─── Provision new GoPhish instance ────────────────────────────────────
app.post('/provision', requireAuth, async (req, res) => {
  const { customer_id, email, plan } = req.body;
  if (!customer_id) {
    return res.status(400).json({ error: 'customer_id required' });
  }

  const registry = loadRegistry();

  // Already provisioned?
  if (registry[customer_id]) {
    return res.json({ status: 'exists', ...registry[customer_id] });
  }

  try {
    const port = await findNextPort();
    const containerName = `gophish-${customer_id}`;
    const dataDir = path.join(DATA_DIR, 'customers', customer_id);
    fs.mkdirSync(dataDir, { recursive: true });

    // Generate admin password for this instance
    const adminPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);

    // Pull image if needed
    try {
      await docker.getImage(GOPHISH_IMAGE).inspect();
    } catch {
      console.log(`[provision] Pulling ${GOPHISH_IMAGE}...`);
      await new Promise((resolve, reject) => {
        docker.pull(GOPHISH_IMAGE, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
        });
      });
    }

    // Create container
    const containerConfig = {
      Image: GOPHISH_IMAGE,
      name: containerName,
      Env: [
        `GOPHISH_ADMIN_PASSWORD=${adminPassword}`,
      ],
      ExposedPorts: { '3333/tcp': {} },
      HostConfig: {
        PortBindings: {
          '3333/tcp': [{ HostPort: String(port) }]
        },
        Binds: [
          `${dataDir}:/opt/gophish/data`
        ],
        RestartPolicy: { Name: 'unless-stopped' }
      },
      Labels: {
        'edgeiq.customer': customer_id,
        'edgeiq.service': 'phishsim',
        // Traefik labels for direct routing
        'traefik.enable': 'true',
        [`traefik.http.routers.phishsim-${customer_id}.rule`]: `Host(\`${customer_id}.phishsim.edgeiqlabs.com\`)`,
        [`traefik.http.routers.phishsim-${customer_id}.entrypoints`]: 'websecure-external',
        [`traefik.http.routers.phishsim-${customer_id}.tls.certresolver`]: 'dns-cloudflare',
        [`traefik.http.services.phishsim-${customer_id}.loadbalancer.server.port`]: '3333'
      }
    };

    const container = await docker.createContainer(containerConfig);

    // Connect to Traefik network
    try {
      const network = docker.getNetwork(TRAEFIK_NETWORK);
      await network.connect({ Container: container.id });
    } catch (e) {
      console.warn(`[provision] Could not connect to ${TRAEFIK_NETWORK}:`, e.message);
    }

    await container.start();

    // Wait for GoPhish to initialize
    await new Promise(r => setTimeout(r, 5000));

    const dashboardUrl = `https://${customer_id}.phishsim.edgeiqlabs.com`;
    const apiUrl = `http://${PUBLIC_IP}:${port}`;

    const instance = {
      customer_id,
      container_name: containerName,
      container_id: container.id.slice(0, 12),
      port,
      dashboard_url: dashboardUrl,
      api_url: apiUrl,
      admin_email: email || 'admin@localhost',
      admin_password: adminPassword,
      plan: plan || 'starter',
      created_at: new Date().toISOString(),
      status: 'running'
    };

    registry[customer_id] = instance;
    saveRegistry(registry);

    console.log(`[provision] Created ${containerName} on port ${port} for ${customer_id}`);
    res.status(201).json({ status: 'provisioned', ...instance });

  } catch (err) {
    console.error(`[provision] Failed for ${customer_id}:`, err.message);
    res.status(500).json({ error: 'Provisioning failed', detail: err.message });
  }
});

// ─── List all instances ─────────────────────────────────────────────────
app.get('/instances', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  // Check actual container status
  const containers = await docker.listContainers({ all: true });
  const containerMap = {};
  for (const c of containers) {
    for (const name of c.Names) {
      containerMap[name.replace(/^\//, '')] = c.State;
    }
  }
  const instances = Object.entries(registry).map(([id, inst]) => ({
    ...inst,
    container_status: containerMap[inst.container_name] || 'missing'
  }));
  res.json({ instances, total: instances.length });
});

// ─── Get single instance ────────────────────────────────────────────────
app.get('/instances/:customerId', requireAuth, (req, res) => {
  const registry = loadRegistry();
  const inst = registry[req.params.customerId];
  if (!inst) return res.status(404).json({ error: 'Instance not found' });
  res.json(inst);
});

// ─── Suspend instance ──────────────────────────────────────────────────
app.post('/instances/:customerId/suspend', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  const inst = registry[req.params.customerId];
  if (!inst) return res.status(404).json({ error: 'Instance not found' });
  try {
    const container = docker.getContainer(inst.container_name);
    await container.stop();
    inst.status = 'suspended';
    saveRegistry(registry);
    res.json({ status: 'suspended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Resume instance ───────────────────────────────────────────────────
app.post('/instances/:customerId/resume', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  const inst = registry[req.params.customerId];
  if (!inst) return res.status(404).json({ error: 'Instance not found' });
  try {
    const container = docker.getContainer(inst.container_name);
    await container.start();
    inst.status = 'running';
    saveRegistry(registry);
    res.json({ status: 'resumed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete instance ───────────────────────────────────────────────────
app.delete('/instances/:customerId', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  const inst = registry[req.params.customerId];
  if (!inst) return res.status(404).json({ error: 'Instance not found' });
  try {
    const container = docker.getContainer(inst.container_name);
    await container.stop().catch(() => {});
    await container.remove();
    delete registry[req.params.customerId];
    saveRegistry(registry);
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy to customer GoPhish instance ─────────────────────────────────
// This is what the CF Pages catchall uses to manage campaigns/templates/etc
// ─── Session invalidation helper ──────────────────────────────────────────────
// GoPhish stores sessions in SQLite and does NOT invalidate them on password
// change or logout (known bug: gophish/gophish#9368). We fix this at the proxy
// layer by deleting stale sessions from the GoPhish DB after sensitive ops.
// Uses dockerode to run a one-shot alpine/sqlite container that mounts the
// customer's GoPhish DB directory (no sqlite3 needed in manager container).
// Reuses the global `docker` instance declared at line 13.

async function invalidateGoPhishSessions(inst, exceptSessionId = null) {
  // GoPhish DBs are bind-mounted at /opt/gophish/<customer_id>/ on the host
  const hostDbDir = `/opt/gophish/${inst.id}`;
  const query = exceptSessionId
    ? `DELETE FROM sessions WHERE key != '${exceptSessionId.replace(/'/g, "''")}';`
    : 'DELETE FROM sessions;';

  try {
    // Pull image if needed (cached after first run)
    try { await docker.getImage('alpine/sqlite').inspect(); } catch {
      console.log('[session-invalidation] Pulling alpine/sqlite image...');
      await new Promise((res, rej) => {
        docker.pull('alpine/sqlite', (err, stream) => {
          if (err) return rej(err);
          docker.modem.followProgress(stream, (e) => e ? rej(e) : res());
        });
      });
    }

    // Run one-shot container: mount DB dir read-write, execute DELETE, auto-remove
    const container = await docker.createContainer({
      Image: 'alpine/sqlite',
      Cmd: ['sh', '-c', `apk add --no-cache sqlite-libs > /dev/null 2>&1; sqlite3 /db/gophish.db "${query}"`],
      HostConfig: {
        Binds: [`${hostDbDir}:/db:rw`],
        AutoRemove: true,
        NetworkMode: 'none',
      },
    });
    await container.start();
    const result = await container.wait(10000);
    if (result.StatusCode !== 0) {
      console.error(`[session-invalidation] sqlite3 exited ${result.StatusCode} for ${inst.id}`);
    } else {
      console.log(`[session-invalidation] Cleared sessions for ${inst.id}${exceptSessionId ? ' (except current)' : ''}`);
    }
  } catch (err) {
    console.error(`[session-invalidation] Failed for ${inst.id}:`, err.message);
  }
}

// Detect password-change and logout requests that need session invalidation
function isSessionInvalidationTrigger(method, gophishPath) {
  // Password change: PUT /api/users/:id or POST /api/users/:id/password
  if ((method === 'PUT' || method === 'POST') && /^\/api\/users\/\d+(\/password)?$/.test(gophishPath)) return true;
  // Reset password: POST /api/reset_password
  if (method === 'POST' && gophishPath === '/api/reset_password') return true;
  // Logout: POST /logout or GET /logout
  if ((method === 'POST' || method === 'GET') && gophishPath === '/logout') return true;
  return false;
}

app.all('/proxy/:customerId/*', requireAuth, async (req, res) => {
  const registry = loadRegistry();
  const inst = registry[req.params.customerId];
  if (!inst) return res.status(404).json({ error: 'Instance not found' });

  // Build target URL
  const gophishPath = req.params[0] || '';
  const targetUrl = `http://127.0.0.1:${inst.port}/${gophishPath}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
      }
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const text = await response.text();

    // On successful password change or logout, invalidate other sessions
    if (response.ok && isSessionInvalidationTrigger(req.method, gophishPath)) {
      // Extract current session cookie to preserve it (if present)
      const setCookie = response.headers.get('set-cookie') || '';
      const match = setCookie.match(/_gophish=([^;]+)/);
      const currentSession = match ? match[1] : null;
      // Fire-and-forget — don't block the response
      invalidateGoPhishSessions(inst, currentSession).catch(err =>
        console.error('[session-invalidation] Async error:', err.message)
      );
    }

    res.status(response.status);
    try {
      res.json(JSON.parse(text));
    } catch {
      res.send(text);
    }
  } catch (err) {
    res.status(502).json({ error: 'GoPhish unreachable', detail: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'customers'), { recursive: true });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[phishsim-manager] Listening on :${PORT}`);
  console.log(`[phishsim-manager] Data dir: ${DATA_DIR}`);
  console.log(`[phishsim-manager] Base port: ${BASE_PORT}`);
});
