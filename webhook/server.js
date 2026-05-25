'use strict';

const express = require('express');
const Stripe  = require('stripe');
const crypto  = require('crypto');

const app = express();

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PTERODACTYL_API_KEY,
  PTERODACTYL_URL   = 'http://localhost',
  RESEND_API_KEY,
  PANEL_URL         = 'https://panel.edgeiqlabs.com',
  SERVER_IP         = '100.33.233.11',
  PORT              = '3001',
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ─── Plans: Stripe price ID → resource limits ────────────────────────────────
const PLANS = {
  // Game plans  (egg/nest are defaults; overridden by game dropdown selection)
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
};

// ─── Game Map: dropdown value → Pterodactyl egg/nest ─────────────────────────
// Values must match the Stripe payment link custom_fields dropdown option values
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

// ─── Checkout handler ─────────────────────────────────────────────────────────
async function handleCheckout(session) {
  const email     = session.customer_details?.email;
  const rawName   = session.customer_details?.name || '';
  const firstName = rawName.split(' ')[0] || email.split('@')[0];
  const lastName  = rawName.split(' ').slice(1).join(' ') || 'Customer';
  if (!email) { console.error('[checkout] No email:', session.id); return; }

  // Resolve price ID from subscription
  let priceId;
  if (session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription);
    priceId = sub.items.data[0]?.price?.id;
  }
  const plan = PLANS[priceId];
  if (!plan) { console.error('[checkout] Unknown price:', priceId); return; }
  console.log(`[checkout] ${email} -> ${plan.name}`);

  // ── Resolve egg/nest from game selection (game orders only) ──────────────
  let eggId   = plan.egg;
  let nestId  = plan.nest;
  let gameName = null;

  if (plan.type === 'game') {
    const gameField = (session.custom_fields || []).find(f => f.key === 'game');
    const gameKey   = gameField?.dropdown?.value || 'papermcjava';
    const gameInfo  = GAME_MAP[gameKey];
    if (gameInfo) {
      eggId    = gameInfo.egg;
      nestId   = gameInfo.nest;
      gameName = gameInfo.display;
    } else {
      console.warn(`[checkout] Unknown game key: ${gameKey}, defaulting to Paper MC`);
      gameName = 'Paper Minecraft';
    }
    console.log(`[checkout] Game: ${gameName} (egg=${eggId}, nest=${nestId})`);
  }

  // ── Fetch egg details from Pterodactyl (docker image, startup, env vars) ──
  const eggData  = await ptero('GET', `/api/application/nests/${nestId}/eggs/${eggId}?include=variables`);
  const eggAttrs = eggData.attributes;
  const dockerImage = eggAttrs.docker_image;
  const startup     = eggAttrs.startup;

  // Build environment from egg's variable defaults
  const environment = {};
  for (const varDef of (eggAttrs.relationships?.variables?.data || [])) {
    const v = varDef.attributes;
    environment[v.env_variable] = v.default_value ?? '';
  }
  console.log(`[ptero] Egg ${eggId}: image=${dockerImage}`);

  // ── Create Pterodactyl user ───────────────────────────────────────────────
  const password = crypto.randomBytes(12).toString('base64url').slice(0, 16);
  const username = 'user_' + crypto.randomBytes(4).toString('hex');

  const ptUser = await ptero('POST', '/api/application/users', {
    email, username, first_name: firstName, last_name: lastName, password,
  });
  const userId = ptUser.attributes.id;
  console.log(`[ptero] User id=${userId}`);

  // ── Create server ─────────────────────────────────────────────────────────
  const serverName = plan.type === 'game'
    ? `${firstName}'s ${gameName} Server`
    : `${firstName}'s Bot Server`;

  const server = await ptero('POST', '/api/application/servers', {
    name: serverName,
    user: userId,
    egg:  eggId,
    docker_image: dockerImage,
    startup,
    environment,
    limits: { memory:plan.memory, swap:0, disk:plan.disk, io:500, cpu:plan.cpu },
    feature_limits: { databases:1, backups:2, allocations:0 },
    deploy: { locations:[1], dedicated_ip:false, port_range:[plan.portRange] },
  });

  const serverPort = server.attributes?.relationships?.allocations?.data?.[0]?.attributes?.port;
  console.log(`[ptero] Server id=${server.attributes.id} port=${serverPort}`);

  await sendWelcome({ email, firstName, plan, password, serverPort, serverName, gameName });
  console.log(`[done] ${email} onboarded`);
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

// ─── Welcome email ────────────────────────────────────────────────────────────
async function sendWelcome({ email, firstName, plan, password, serverPort, serverName, gameName }) {
  const isGame  = plan.type === 'game';
  const accent  = isGame ? '#4ade80' : '#7c6fef';
  const border  = isGame ? '#1e3a2a' : '#1e1a3a';
  const codeBg  = isGame ? '#112211' : '#111122';
  const emoji   = isGame ? '🎮' : '🤖';
  const gameLabel = gameName || 'Game';
  const subject = `${emoji} Your ${plan.name} server is ready!`;
  const addr    = isGame && serverPort ? `${SERVER_IP}:${serverPort}` : null;

  const steps = isGame ? `
    <li>Log in at <a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a></li>
    <li>Click <strong>${serverName}</strong> then hit <strong>Start</strong></li>
    <li>Allow 1–3 minutes for ${gameLabel} to download and start</li>
    ${addr ? `<li>Connect to your server at: <strong style="color:${accent};">${addr}</strong></li>` : ''}
    <li>Questions or need help? Reply to this email or join Discord</li>` : `
    <li>Log in at <a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a></li>
    <li>Click <strong>${serverName}</strong> → <strong>Files</strong> tab</li>
    <li>Upload your bot files or set a Git URL in the Startup tab</li>
    <li>Hit <strong>Start</strong></li>
    <li>Need Python or Java instead of Node.js? Just reply</li>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0b0f14;font-family:sans-serif;">
<div style="max-width:600px;margin:40px auto;padding:0 20px;">
  <h1 style="color:${accent};font-size:1.8rem;margin:0 0 8px;">${emoji} Your Server is Live!</h1>
  <p style="color:#9fb0c7;margin:0 0 24px;">Hi ${firstName} — your <strong style="color:#e8eef7;">${plan.name}</strong>${isGame ? ` running <strong style="color:${accent};">${gameLabel}</strong>` : ''} is ready.</p>
  <div style="background:#0d1620;border:1px solid ${border};border-radius:12px;padding:24px;margin-bottom:20px;">
    <h2 style="color:${accent};font-size:.9rem;margin:0 0 14px;text-transform:uppercase;letter-spacing:.06em;">Login Credentials</h2>
    <table style="width:100%;font-size:.9rem;">
      <tr><td style="padding:4px 0;color:#9fb0c7;width:120px;">Panel</td><td><a href="${PANEL_URL}" style="color:${accent};">${PANEL_URL}</a></td></tr>
      <tr><td style="padding:4px 0;color:#9fb0c7;">Username</td><td style="color:#e8eef7;">${email}</td></tr>
      <tr><td style="padding:4px 0;color:#9fb0c7;">Password</td><td><code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${password}</code></td></tr>
      ${addr ? `<tr><td style="padding:4px 0;color:#9fb0c7;">Server IP</td><td><code style="background:${codeBg};color:${accent};padding:3px 9px;border-radius:4px;">${addr}</code></td></tr>` : ''}
    </table>
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

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization:`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ from:'EdgeIQ <noreply@edgeiqlabs.com>', to:[email], subject, html }),
  });
  if (!res.ok) console.error('[resend] Failed:', await res.text());
  else console.log(`[resend] Sent -> ${email}`);
}

app.listen(Number(PORT), () => console.log(`[server] Listening on :${PORT}`));
