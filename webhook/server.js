'use strict';

const express = require('express');
const Stripe  = require('stripe');
const crypto  = require('crypto');
const https   = require('https');

const app = express();

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PTERODACTYL_API_KEY,
  PTERODACTYL_URL    = 'http://localhost',
  PROXMOX_URL        = 'https://10.5.1.236:8006',
  PROXMOX_TOKEN,                          // root@pam!edgeiq=<secret>
  PROXMOX_NODE       = 'pve',
  PROXMOX_STORAGE    = 'tank',            // ZFS pool for container rootfs
  CYBERPANEL_URL     = 'https://localhost:8090', // CyberPanel admin API
  CYBERPANEL_USER    = 'admin',
  CYBERPANEL_PASS,                        // set in .env
  RESEND_API_KEY,
  PANEL_URL          = 'https://panel.edgeiqlabs.com',
  SERVER_IP          = '100.33.233.11',
  PORT               = '3001',
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// Proxmox ignores self-signed cert for internal API
const proxmoxAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Plans ────────────────────────────────────────────────────────────────────
const PLANS = {
  // Game plans (egg/nest overridden by game dropdown)
  'price_1TadEJRC1NZ20yDTe3ur18Pk': { type:'game', name:'Play Starter',  memory:2048, disk:10240, cpu:100, nest:1, egg:1, portRange:'25566-25600' },
  'price_1TaKiBRC1NZ20yDTRpsosVTW': { type:'game', name:'Play Starter',  memory:2048, disk:10240, cpu:100, nest:1, egg:1, portRange:'25566-25600' },
  'price_1TaKiBRC1NZ20yDTWpWHqkdB': { type:'game', name:'Play Standard', memory:4096, disk:20480, cpu:200, nest:1, egg:1, portRange:'25566-25600' },
  'price_1TaKiBRC1NZ20yDTzX0wj9FM': { type:'game', name:'Play Pro',      memory:8192, disk:40960, cpu:300, nest:1, egg:1, portRange:'25566-25600' },
  // Bot plans
  'price_1Taf5ARC1NZ20yDT8yM3nL1i': { type:'bot', name:'Bots Basic',    memory:512,  disk:2048,  cpu:50,  nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf51RC1NZ20yDTAubMcjxY': { type:'bot', name:'Bots Basic',    memory:512,  disk:2048,  cpu:50,  nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf5MRC1NZ20yDTg3gflGPs': { type:'bot', name:'Bots Standard', memory:1024, disk:5120,  cpu:100, nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf5GRC1NZ20yDTL9GZToCI': { type:'bot', name:'Bots Standard', memory:1024, disk:5120,  cpu:100, nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf52RC1NZ20yDTOJL4b8M5': { type:'bot', name:'Bots Standard', memory:1024, disk:5120,  cpu:100, nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf5MRC1NZ20yDTnnrm1gNs': { type:'bot', name:'Bots Pro',      memory:2048, disk:10240, cpu:150, nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf5GRC1NZ20yDTmWZBrxng': { type:'bot', name:'Bots Pro',      memory:2048, disk:10240, cpu:150, nest:6, egg:23, portRange:'40000-40100' },
  'price_1Taf52RC1NZ20yDTfQ2SfrdW': { type:'bot', name:'Bots Pro',      memory:2048, disk:10240, cpu:150, nest:6, egg:23, portRange:'40000-40100' },
  // VPS plans  (cores/diskGB used for Proxmox LXC)
  'price_1Tb2VFRC1NZ20yDTfhCJ6651': { type:'vps', name:'VPS Nano',     memory:512,  diskGB:10, cores:1 },
  'price_1Tb2VHRC1NZ20yDTPFoMZmhj': { type:'vps', name:'VPS Micro',    memory:1024, diskGB:20, cores:1 },
  'price_1Tb2VJRC1NZ20yDTIFFVAmJb': { type:'vps', name:'VPS Basic',    memory:2048, diskGB:40, cores:2 },
  'price_1Tb2VKRC1NZ20yDTawsJRCJ6': { type:'vps', name:'VPS Standard', memory:4096, diskGB:80, cores:4 },
  // Web hosting plans (CyberPanel)
  'price_1TbQ8WRC1NZ20yDTS2CiCp2Y': { type:'web', name:'Web Starter',   sites:1,  diskGB:5,  wordpress:false },
  'price_1TbQ8XRC1NZ20yDTEjp7Pz1z': { type:'web', name:'Web Business',  sites:5,  diskGB:20, wordpress:false },
  'price_1TbQ8XRC1NZ20yDT0UqN0EpZ': { type:'web', name:'Web Pro',       sites:0,  diskGB:50, wordpress:false },
  // WordPress hosting plans (CyberPanel + auto WP install)
  'price_1TbQ8YRC1NZ20yDTzmw9D2JU': { type:'web', name:'WP Starter',    sites:1,  diskGB:5,  wordpress:true },
  'price_1TbQ8ZRC1NZ20yDTeaircyqg': { type:'web', name:'WP Business',   sites:3,  diskGB:20, wordpress:true },
  'price_1TbQ8aRC1NZ20yDTunPI1he6': { type:'web', name:'WP Pro',        sites:0,  diskGB:50, wordpress:true },
};

// ─── Game Map ─────────────────────────────────────────────────────────────────
const GAME_MAP = {
  papermcjava:       { egg: 1,  nest: 1, display: 'Paper Minecraft'       },
  vanillamc:         { egg: 5,  nest: 1, display: 'Vanilla Minecraft'      },
  minecraftforge:    { egg: 3,  nest: 1, display: 'Minecraft Forge'        },
  minecraftbedrock:  { egg: 22, nest: 1, display: 'Minecraft Bedrock'      },
  garrysmod:         { egg: 6,  nest: 2, display: "Garry's Mod"            },
  ark:               { egg: 8,  nest: 2, display: 'ARK: Survival Evolved'  },
  csgo:              { egg: 10, nest: 2, display: 'CS:GO'                  },
  tf2:               { egg: 11, nest: 2, display: 'Team Fortress 2'        },
  rust:              { egg: 14, nest: 4, display: 'Rust'                   },
  valheim:           { egg: 15, nest: 5, display: 'Valheim'                },
  palworld:          { egg: 16, nest: 5, display: 'Palworld'               },
  sevendaystodie:    { egg: 17, nest: 5, display: '7 Days to Die'          },
  eco:               { egg: 18, nest: 5, display: 'Eco'                    },
  spaceengineers:    { egg: 19, nest: 5, display: 'Space Engineers'        },
  conanexiles:       { egg: 20, nest: 5, display: 'Conan Exiles'           },
  terraria:          { egg: 21, nest: 5, display: 'Terraria'               },
  dayz:              { egg: 25, nest: 5, display: 'DayZ'                   },
  dst:               { egg: 26, nest: 5, display: "Don't Starve Together"  },
  projectzomboid:    { egg: 27, nest: 5, display: 'Project Zomboid'        },
  satisfactory:      { egg: 28, nest: 5, display: 'Satisfactory'           },
  sonsoftheforest:   { egg: 29, nest: 5, display: 'Sons of the Forest'     },
  squad:             { egg: 30, nest: 5, display: 'Squad'                  },
  vrising:           { egg: 31, nest: 5, display: 'V Rising'               },
  fivem:             { egg: 32, nest: 7, display: 'FiveM'                  },
};

// ─── VPS OS Map ───────────────────────────────────────────────────────────────
// Dropdown values match Stripe custom_fields option values (alphanumeric only)
const VPS_OS_MAP = {
  ubuntu2404:  { template: 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst',  display: 'Ubuntu 24.04 LTS' },
  debian12:    { template: 'local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst',     display: 'Debian 12'        },
  rocky9:      { template: 'local:vztmpl/rockylinux-9-default_20240912_amd64.tar.xz',   display: 'Rocky Linux 9'    },
  almalinux9:  { template: 'local:vztmpl/almalinux-9-default_20240911_amd64.tar.xz',    display: 'AlmaLinux 9'      },
};

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status:'ok', ts:new Date().toISOString() }));

app.post('/stripe', express.raw({ type:'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Sig error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  res.json({ received: true });
  if (event.type === 'checkout.session.completed') {
    handleCheckout(event.data.object).catch(e =>
      console.error('[checkout] Error:', e.message, e.details || '')
    );
  }
});

// ─── Main checkout handler ───────────────────────────────────────────────────
async function handleCheckout(session) {
  const email     = session.customer_details?.email;
  const rawName   = session.customer_details?.name || '';
  const firstName = rawName.split(' ')[0] || email.split('@')[0];
  const lastName  = rawName.split(' ').slice(1).join(' ') || 'Customer';
  if (!email) { console.error('[checkout] No email:', session.id); return; }

  let priceId;
  if (session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription);
    priceId = sub.items.data[0]?.price?.id;
  }
  const plan = PLANS[priceId];
  if (!plan) { console.error('[checkout] Unknown price:', priceId); return; }
  console.log(`[checkout] ${email} -> ${plan.name} (${plan.type})`);

  if (plan.type === 'vps') {
    return handleVPS(session, plan, email, firstName, lastName);
  }
  if (plan.type === 'web') {
    return handleWebHosting(session, plan, email, firstName, lastName);
  }

  // ── Game / Bot provisioning (Pterodactyl) ────────────────────────────────
  let eggId  = plan.egg;
  let nestId = plan.nest;
  let gameName = null;

  if (plan.type === 'game') {
    const gameField = (session.custom_fields || []).find(f => f.key === 'game');
    const gameKey   = gameField?.dropdown?.value || 'papermcjava';
    const gameInfo  = GAME_MAP[gameKey];
    if (gameInfo) { eggId = gameInfo.egg; nestId = gameInfo.nest; gameName = gameInfo.display; }
    else { gameName = 'Paper Minecraft'; }
    console.log(`[checkout] Game: ${gameName} (egg=${eggId}, nest=${nestId})`);
  }

  const eggData     = await ptero('GET', `/api/application/nests/${nestId}/eggs/${eggId}?include=variables`);
  const eggAttrs    = eggData.attributes;
  const dockerImage = eggAttrs.docker_image;
  const startup     = eggAttrs.startup;
  const environment = {};
  for (const v of (eggAttrs.relationships?.variables?.data || []))
    environment[v.attributes.env_variable] = v.attributes.default_value ?? '';
  console.log(`[ptero] Egg ${eggId}: image=${dockerImage}`);

  const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const username = 'user_' + crypto.randomBytes(4).toString('hex');
  const ptUser   = await ptero('POST', '/api/application/users', {
    email, username, first_name: firstName, last_name: lastName, password,
  });
  const userId = ptUser.attributes.id;
  console.log(`[ptero] User id=${userId}`);

  const serverName = plan.type === 'game'
    ? `${firstName}'s ${gameName} Server`
    : `${firstName}'s Bot Server`;

  const server = await ptero('POST', '/api/application/servers', {
    name: serverName, user: userId, egg: eggId,
    docker_image: dockerImage, startup, environment,
    limits: { memory:plan.memory, swap:0, disk:plan.disk, io:500, cpu:plan.cpu },
    feature_limits: { databases:1, backups:2, allocations:0 },
    deploy: { locations:[1], dedicated_ip:false, port_range:[plan.portRange] },
  });

  const serverPort = server.attributes?.relationships?.allocations?.data?.[0]?.attributes?.port;
  console.log(`[ptero] Server id=${server.attributes.id} port=${serverPort}`);
  await sendGameBotWelcome({ email, firstName, plan, password, serverPort, serverName, gameName });
  console.log(`[done] ${email} onboarded (game/bot)`);
}

// ─── VPS provisioning (Proxmox LXC) ──────────────────────────────────────────
async function handleVPS(session, plan, email, firstName, lastName) {
  // Resolve OS selection
  const osField   = (session.custom_fields || []).find(f => f.key === 'os');
  const osKey     = osField?.dropdown?.value || 'ubuntu2404';
  const osInfo    = VPS_OS_MAP[osKey] || VPS_OS_MAP.ubuntu2404;
  console.log(`[vps] OS: ${osInfo.display} (${osKey})`);

  // Find next available VMID (start from 201)
  const containers = await proxmoxAPI('GET', `/nodes/${PROXMOX_NODE}/lxc`);
  const usedVMIDs  = new Set(containers.data.map(c => Number(c.vmid)));
  let vmid = 201;
  while (usedVMIDs.has(vmid)) vmid++;

  // IP derived from VMID: CT201 → 10.10.0.101, CT202 → 10.10.0.102, etc.
  const octet     = vmid - 100;
  const ip        = `10.10.0.${octet}`;
  const sshPort   = 22000 + octet;
  const appStart  = 30000 + octet * 20;
  const appEnd    = appStart + 19;
  console.log(`[vps] VMID=${vmid} IP=${ip} SSH=${sshPort} APP=${appStart}-${appEnd}`);

  // Generate credentials
  const rootPassword = crypto.randomBytes(10).toString('base64url').slice(0, 14);
  const hostname     = 'vps-' + crypto.randomBytes(3).toString('hex');

  // Create LXC container
  const task = await proxmoxAPI('POST', `/nodes/${PROXMOX_NODE}/lxc`, {
    vmid,
    hostname,
    ostemplate:  osInfo.template,
    memory:      plan.memory,
    swap:        0,
    cores:       plan.cores,
    rootfs:      `${PROXMOX_STORAGE}:${plan.diskGB}`,
    net0:        `name=eth0,bridge=vmbr2,ip=${ip}/24,gw=10.10.0.1`,
    password:    rootPassword,
    unprivileged: 1,
    nameserver:  '1.1.1.1',
    hookscript:  'local:snippets/edgeiq-nat.sh',
    start:       1,
  });
  console.log(`[proxmox] Created CT${vmid}, task: ${task.data}`);

  // Wait for container to start and hookscript to apply DNAT rules
  await waitForProxmoxTask(task.data);
  await new Promise(r => setTimeout(r, 8000)); // hookscript needs a moment

  await sendVPSWelcome({ email, firstName, plan, osDisplay: osInfo.display,
    hostname, rootPassword, sshPort, appStart, appEnd, ip });
  console.log(`[done] ${email} VPS CT${vmid} provisioned`);
}

// ─── Web Hosting provisioning (CyberPanel) ───────────────────────────────────
async function handleWebHosting(session, plan, email, firstName, lastName) {
  const isWP     = plan.wordpress;
  const username = 'user_' + crypto.randomBytes(4).toString('hex');
  const password = crypto.randomBytes(10).toString('base64url').slice(0, 14);
  // Use a sanitised subdomain as the primary domain (customer can add their real domain later)
  const slug     = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
  const domain   = `${slug}.edgeiqlabs.com`;

  console.log(`[web] Provisioning ${plan.name} for ${email} → ${domain}`);

  // 1. Create CyberPanel user account
  await cyberPanel('createUser', {
    firstName, lastName,
    email,
    userName:  username,
    password,
    websiteLimit: plan.sites === 0 ? 9999 : plan.sites,
    selectedACL:  'user',
    securityLevel: 'HIGH',
    status: 1,
  });
  console.log(`[cyberpanel] User created: ${username}`);

  // 2. Create the primary website
  await cyberPanel('createWebsite', {
    domainName: domain,
    ownerEmail: email,
    websiteOwner: username,
    packageName: 'Default',
    websiteTemplate: 'Default',
    ssl: 1,
    dkimCheck: 1,
    openBasedir: 1,
  });
  console.log(`[cyberpanel] Website created: ${domain}`);

  // 3. For WordPress plans — auto-install WordPress
  let wpAdminPass = null;
  if (isWP) {
    wpAdminPass = crypto.randomBytes(10).toString('base64url').slice(0, 14);
    await cyberPanel('installWordPress', {
      domainName:   domain,
      title:        `${firstName}'s Site`,
      adminUser:    'admin',
      adminEmail:   email,
      adminPassword: wpAdminPass,
      dbName:       `wp_${username}`.slice(0, 64),
    });
    console.log(`[cyberpanel] WordPress installed on ${domain}`);
  }

  await sendWebWelcome({ email, firstName, plan, username, password, domain, wpAdminPass, isWP });
  console.log(`[done] ${email} web hosting provisioned (${plan.name})`);
}

// ─── CyberPanel API helper ────────────────────────────────────────────────────
async function cyberPanel(action, params) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const url   = `${CYBERPANEL_URL}/api/${action}`;
  const body  = JSON.stringify({ adminUser: CYBERPANEL_USER, adminPass: CYBERPANEL_PASS, ...params });
  const res   = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // @ts-ignore — node-fetch / undici agent
    agent,
  });
  const data = await res.json();
  if (data.errorMessage && data.errorMessage !== 'None') {
    throw new Error(`CyberPanel ${action} error: ${data.errorMessage}`);
  }
  return data;
}

// ─── Web hosting welcome email ────────────────────────────────────────────────
async function sendWebWelcome({ email, firstName, plan, username, password, domain, wpAdminPass, isWP }) {
  const accent  = '#f97316';
  const border  = '#3a1e0a';
  const codeBg  = '#1a0e05';
  const emoji   = '🌐';
  const subject = `${emoji} Your ${plan.name} hosting is ready!`;

  const cpURL = CYBERPANEL_URL.replace(':8090', ':8090');

  const steps = isWP ? `
    <li>Log in to CyberPanel: <a href="${cpURL}" style="color:${accent};">${cpURL}</a></li>
    <li>Your WordPress site is live at <strong style="color:${accent};">${domain}</strong></li>
    <li>Log in to WordPress admin: <a href="https://${domain}/wp-admin" style="color:${accent};">https://${domain}/wp-admin</a></li>
    <li>Use the WordPress credentials in the box below</li>
    <li>To use your own domain: point its A record to the IP below, then add it in CyberPanel → Websites → Add Domain</li>
    <li>Questions? Reply to this email or join Discord</li>` : `
    <li>Log in to CyberPanel: <a href="${cpURL}" style="color:${accent};">${cpURL}</a></li>
    <li>Your site is live at <strong style="color:${accent};">${domain}</strong></li>
    <li>Upload files via CyberPanel → File Manager, or use FTP</li>
    <li>To install WordPress: CyberPanel → WP Manager → Install</li>
    <li>To use your own domain: point its A record to the IP below, then add it in CyberPanel → Websites → Add Domain</li>
    <li>Questions? Reply to this email or join Discord</li>`;

  const rows = [
    ['CyberPanel',  `<a href="${cpURL}" style="color:${accent};">${cpURL}</a>`],
    ['Username',    `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${username}</code>`],
    ['Password',    `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${password}</code>`],
    ['Your Domain', `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${domain}</code>`],
    ['Server IP',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${SERVER_IP}</code>`],
  ];

  if (isWP && wpAdminPass) {
    rows.push(['WP Admin URL',  `<a href="https://${domain}/wp-admin" style="color:${accent};">https://${domain}/wp-admin</a>`]);
    rows.push(['WP Username',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">admin</code>`]);
    rows.push(['WP Password',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${wpAdminPass}</code>`]);
  }

  const html = buildEmail({
    accent, border, codeBg, emoji,
    title:    `${emoji} Your Hosting is Live!`,
    subtitle: `Hi ${firstName} — your <strong style="color:#e8eef7;">${plan.name}</strong> is ready.${isWP ? ' WordPress has been pre-installed.' : ''}`,
    rows,
    steps,
  });

  await sendEmail({ to: email, subject, html });
  console.log(`[resend] Web hosting welcome -> ${email}`);
}

// ─── Wait for Proxmox async task ──────────────────────────────────────────────
async function waitForProxmoxTask(upid, timeoutMs = 120000) {
  const node    = PROXMOX_NODE;
  const encoded = encodeURIComponent(upid);
  const start   = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await proxmoxAPI('GET', `/nodes/${node}/tasks/${encoded}/status`);
      if (res.data?.status === 'stopped') {
        if (res.data.exitstatus !== 'OK')
          throw new Error(`Proxmox task failed: ${res.data.exitstatus}`);
        return res.data;
      }
    } catch (e) { if (e.message.includes('failed')) throw e; }
  }
  throw new Error('Proxmox task timed out');
}

// ─── Proxmox API helper ───────────────────────────────────────────────────────
async function proxmoxAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const url   = new URL(`${PROXMOX_URL}/api2/json${path}`);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port:     url.port || 8006,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Authorization': `PVEAPIToken=${PROXMOX_TOKEN}`,
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      agent: proxmoxAgent,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(`Proxmox ${method} ${path} -> HTTP ${res.statusCode}`);
            err.details = data;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error(`Proxmox parse error: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Pterodactyl API helper ───────────────────────────────────────────────────
async function ptero(method, path, body) {
  const res = await fetch(`${PTERODACTYL_URL}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${PTERODACTYL_API_KEY}`,
      'Content-Type': 'application/json',
      Accept:         'application/vnd.pterodactyl.v1+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`Pterodactyl ${method} ${path} -> HTTP ${res.status}`);
    err.details = JSON.stringify(data?.errors || data);
    throw err;
  }
  return data;
}

// ─── Game/Bot welcome email ───────────────────────────────────────────────────
async function sendGameBotWelcome({ email, firstName, plan, password, serverPort, serverName, gameName }) {
  const isGame   = plan.type === 'game';
  const accent   = isGame ? '#4ade80' : '#7c6fef';
  const border   = isGame ? '#1e3a2a' : '#1e1a3a';
  const codeBg   = isGame ? '#112211' : '#111122';
  const emoji    = isGame ? '🎮' : '🤖';
  const gameLabel = gameName || 'Game';
  const subject  = `${emoji} Your ${plan.name} server is ready!`;
  const addr     = isGame && serverPort ? `${SERVER_IP}:${serverPort}` : null;

  const steps = isGame ? `
    <li>Log in at <a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a></li>
    <li>Click <strong>${serverName}</strong> then hit <strong>Start</strong></li>
    <li>Allow 1–3 minutes for ${gameLabel} to download and start</li>
    ${addr ? `<li>Connect to your server: <strong style="color:${accent};">${addr}</strong></li>` : ''}
    <li>Questions? Reply to this email or join Discord</li>` : `
    <li>Log in at <a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a></li>
    <li>Click <strong>${serverName}</strong> → <strong>Files</strong> tab</li>
    <li>Upload your bot files or set a Git URL in the Startup tab</li>
    <li>Hit <strong>Start</strong></li>
    <li>Need Python or Java? Just reply</li>`;

  const html = buildEmail({
    accent, border, codeBg, emoji,
    title:    `${emoji} Your Server is Live!`,
    subtitle: `Hi ${firstName} — your <strong style="color:#e8eef7;">${plan.name}</strong>${isGame ? ` running <strong style="color:${accent};">${gameLabel}</strong>` : ''} is ready.`,
    rows: [
      ['Panel',    `<a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a>`],
      ['Username', `<span style="color:#e8eef7;">${email}</span>`],
      ['Password', `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${password}</code>`],
      ...(addr ? [['Server IP', `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${addr}</code>`]] : []),
    ],
    steps,
  });

  await sendEmail({ to: email, subject, html });
  console.log(`[resend] Game/bot welcome -> ${email}`);
}

// ─── VPS welcome email ────────────────────────────────────────────────────────
async function sendVPSWelcome({ email, firstName, plan, osDisplay, hostname, rootPassword, sshPort, appStart, appEnd }) {
  const accent = '#2dd4bf';
  const border = '#1a3a36';
  const codeBg = '#0a1e1c';
  const subject = `☁️ Your ${plan.name} container is ready!`;

  const steps = `
    <li>SSH in: <code style="background:${codeBg};color:${accent};padding:2px 8px;border-radius:4px;">ssh root@${SERVER_IP} -p ${sshPort}</code></li>
    <li>Password: the one shown in the credentials box below</li>
    <li>Your app ports <strong style="color:${accent};">${appStart}–${appEnd}</strong> are forwarded to your container — use any of them for your services</li>
    <li>Questions? Reply to this email or join Discord</li>`;

  const html = buildEmail({
    accent, border, codeBg, emoji: '☁️',
    title:    '☁️ Your Container is Live!',
    subtitle: `Hi ${firstName} — your <strong style="color:#e8eef7;">${plan.name}</strong> running <strong style="color:${accent};">${osDisplay}</strong> is ready.`,
    rows: [
      ['SSH Host',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${SERVER_IP}</code>`],
      ['SSH Port',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${sshPort}</code>`],
      ['Username',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">root</code>`],
      ['Password',   `<code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${rootPassword}</code>`],
      ['App Ports',  `<span style="color:#e8eef7;">${appStart}–${appEnd}</span> (TCP &amp; UDP forwarded to your container)`],
      ['OS',         `<span style="color:#e8eef7;">${osDisplay}</span>`],
      ['Hostname',   `<span style="color:#e8eef7;">${hostname}</span>`],
    ],
    steps,
  });

  await sendEmail({ to: email, subject, html });
  console.log(`[resend] VPS welcome -> ${email}`);
}

// ─── Email builder ────────────────────────────────────────────────────────────
function buildEmail({ accent, border, codeBg, emoji, title, subtitle, rows, steps }) {
  const rowsHTML = rows.map(([label, value]) =>
    `<tr><td style="padding:4px 0;color:#9fb0c7;width:120px;vertical-align:top;">${label}</td><td>${value}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0b0f14;font-family:sans-serif;">
<div style="max-width:600px;margin:40px auto;padding:0 20px;">
  <h1 style="color:${accent};font-size:1.8rem;margin:0 0 8px;">${title}</h1>
  <p style="color:#9fb0c7;margin:0 0 24px;">${subtitle}</p>
  <div style="background:#0d1620;border:1px solid ${border};border-radius:12px;padding:24px;margin-bottom:20px;">
    <h2 style="color:${accent};font-size:.9rem;margin:0 0 14px;text-transform:uppercase;letter-spacing:.06em;">Credentials</h2>
    <table style="width:100%;font-size:.9rem;">${rowsHTML}</table>
  </div>
  <div style="background:#0d1620;border:1px solid ${border};border-radius:12px;padding:24px;margin-bottom:24px;">
    <h2 style="color:${accent};font-size:.9rem;margin:0 0 10px;text-transform:uppercase;letter-spacing:.06em;">Getting Started</h2>
    <ol style="color:#9fb0c7;line-height:2.1;margin:0;padding-left:18px;">${steps}</ol>
  </div>
  <div style="text-align:center;padding:20px 0;border-top:1px solid #1a2535;">
    <a href="https://discord.gg/PaP7nsFUJT" style="background:${accent};color:#0b0f14;font-weight:700;padding:11px 28px;border-radius:8px;text-decoration:none;">Join Discord for Help</a>
    <p style="color:#9fb0c7;font-size:.78rem;margin:14px 0 0;">EdgeIQ Labs · <a href="https://edgeiqlabs.com" style="color:${accent};">edgeiqlabs.com</a></p>
  </div>
</div></body></html>`;
}

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization:`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ from:'EdgeIQ <noreply@edgeiqlabs.com>', to:[to], subject, html }),
  });
  if (!res.ok) console.error('[resend] Failed:', await res.text());
}

app.listen(Number(PORT), () => console.log(`[server] Listening on :${PORT}`));
