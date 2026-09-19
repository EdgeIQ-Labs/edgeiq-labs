/**
 * Stripe Webhook: VPS Auto-Provisioning
 *
 * Listens for checkout.session.completed with metadata.plan + metadata.os.
 * Creates an LXC container on Proxmox via API, assigns a dedicated SSH port,
 * generates root credentials, and emails them to the customer via Resend.
 *
 * Env vars: STRIPE_SECRET_KEY (for signature verification),
 *           PVE_API_TOKEN, RESEND_API_KEY, SITE_URL
 *
 * Note: crypto and crypto.subtle are globals in CF Workers/Pages — do NOT import('crypto').
 */

// --- Config ---
const PVE_HOST = '10.5.1.236';
const PVE_NODE = 'pve';
const PVE_STORAGE = 'LXC-Data';
const PVE_BRIDGE = 'vmbr2';
const PVE_SUBNET = '10.10.0'; // IPs: 10.10.0.X
const IP_START = 10; // First assignable IP octet
const IP_END = 200;  // Last assignable (avoid conflicts)
const PUBLIC_IP = '100.33.233.11'; // WAN IP for customer-facing SSH

const OS_TEMPLATES = {
  ubuntu: 'local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst',
  debian: 'local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst',
  rocky:  'local:vztmpl/rockylinux-9-default_20240912_amd64.tar.xz',
  alma:   'local:vztmpl/almalinux-9-default_20240911_amd64.tar.xz',
};

const PLAN_SPECS = {
  nano:     { cores: 1, memory: 512,  swap: 512,  disk: 10, label: 'VPS Nano' },
  micro:    { cores: 1, memory: 1024, swap: 1024, disk: 20, label: 'VPS Micro' },
  basic:    { cores: 2, memory: 2048, swap: 2048, disk: 40, label: 'VPS Basic' },
  standard: { cores: 4, memory: 4096, swap: 4096, disk: 80, label: 'VPS Standard' },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function generatePassword(length = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  let pass = '';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  for (let i = 0; i < length; i++) pass += chars[arr[i] % chars.length];
  return pass;
}

async function pveRequest(path, method, token, body = null) {
  const url = `https://${PVE_HOST}:8006/api2/json${path}`;
  const headers = {
    'Authorization': `PVEAPIToken=${token}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const opts = { method, headers, signal: AbortSignal.timeout(30000) };
  if (body && method !== 'GET') {
    opts.body = new URLSearchParams(body).toString();
  }
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`PVE ${method} ${path} failed: ${resp.status} ${JSON.stringify(data.errors || data)}`);
  return data;
}

async function findNextVMID(token) {
  const data = await pveRequest('/cluster/nextid', 'GET', token);
  return parseInt(data.data, 10);
}

async function findFreeIP(token) {
  // Get all existing CT configs to find used IPs
  const cts = await pveRequest(`/nodes/${PVE_NODE}/lxc`, 'GET', token);
  const usedIPs = new Set();
  for (const ct of (cts.data || [])) {
    try {
      const config = await pveRequest(`/nodes/${PVE_NODE}/lxc/${ct.vmid}/config`, 'GET', token);
      const net0 = config.data?.net0 || '';
      const match = net0.match(/ip=(\d+\.\d+\.\d+\.\d+)/);
      if (match) usedIPs.add(match[1]);
    } catch {}
  }
  for (let i = IP_START; i <= IP_END; i++) {
    const ip = `${PVE_SUBNET}.${i}`;
    if (!usedIPs.has(ip)) return ip;
  }
  throw new Error('No free IPs available in range');
}

function assignSSHPort(vmid) {
  // Deterministic port from VMID: base 22000 + vmid
  return 22000 + vmid;
}

async function sendCredentialsEmail(resendKey, email, name, plan, os, ip, sshPort, password, siteUrl) {
  const spec = PLAN_SPECS[plan];
  const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0b0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="color:#2dd4bf;font-size:24px;margin:0;">Your EdgeIQ VPS is Ready</h1>
  </div>
  <p>Hey ${name || 'there'},</p>
  <p>Your <strong>${spec.label}</strong> container is live. Here are your credentials:</p>
  <div style="background:#111827;border:1px solid #1e3a5a;border-radius:8px;padding:20px;margin:24px 0;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#94a3b8;">Plan</td><td style="padding:6px 0;text-align:right;font-weight:700;">${spec.label} (${spec.cores} vCPU / ${spec.memory}MB RAM / ${spec.disk}GB)</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8;">OS</td><td style="padding:6px 0;text-align:right;font-weight:700;">${os.charAt(0).toUpperCase()+os.slice(1)}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8;">IP Address</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#2dd4bf;">${ip}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8;">SSH Port</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#2dd4bf;">${sshPort}</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8;">User</td><td style="padding:6px 0;text-align:right;font-weight:700;">root</td></tr>
      <tr><td style="padding:6px 0;color:#94a3b8;">Password</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#ff6b6b;">${password}</td></tr>
    </table>
  </div>
  <div style="background:#1a1a2e;border-left:3px solid #2dd4bf;padding:16px;margin:20px 0;border-radius:0 4px 4px 0;">
    <p style="margin:0 0 8px;font-weight:700;color:#2dd4bf;">Connect now:</p>
    <code style="background:#0b0f14;padding:8px 12px;border-radius:4px;display:block;font-size:14px;color:#e2e8f0;">ssh -p ${sshPort} root@${ip}</code>
  </div>
  <p style="font-size:13px;color:#64748b;margin-top:32px;">
    Save your password somewhere safe — we don't store it in plain text.<br>
    Need help? Reply to this email or visit <a href="${siteUrl}" style="color:#2dd4bf;">${siteUrl}</a>.
  </p>
  <p style="font-size:12px;color:#475569;margin-top:24px;text-align:center;">
    EdgeIQ Labs &middot; Linux Container Hosting
  </p>
</div>
</body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'EdgeIQ Labs <vps@edgeiqlabs.com>',
      reply_to: 'support@edgeiqlabs.com',
      to: [email],
      subject: `Your ${spec.label} is ready — credentials inside`,
      html,
    }),
    signal: AbortSignal.timeout(10000),
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  if (!env.STRIPE_SECRET_KEY || !env.PVE_API_TOKEN || !env.RESEND_API_KEY) {
    console.error('Missing required env vars for VPS provisioning');
    return json({ error: 'Service not configured' }, 503);
  }

  // Verify Stripe webhook signature using HMAC-SHA256
  if (env.STRIPE_VPS_WEBHOOK_SECRET && sig) {
    try {
      const parts = Object.fromEntries(sig.split(',').map(p => p.split('=').map(s => s.trim())));
      const timestamp = parts['t'];
      const signatures = sig.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
      if (!timestamp || !signatures.length) throw new Error('Missing timestamp or v1 sig');

      const signedPayload = `${timestamp}.${body}`;
      const keyData = new TextEncoder().encode(env.STRIPE_VPS_WEBHOOK_SECRET);
      const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedPayload));
      const expectedSig = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      // Constant-time comparison to prevent timing attacks
      const valid = signatures.some(s => {
        const a = new TextEncoder().encode(s);
        const b = new TextEncoder().encode(expectedSig);
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
      });

      if (!valid) {
        console.error('Invalid Stripe webhook signature');
        return json({ error: 'Invalid signature' }, 401);
      }

      // Reject events older than 5 minutes
      const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
      if (age > 300) {
        console.error(`Webhook too old: ${age}s`);
        return json({ error: 'Event too old' }, 400);
      }
    } catch (sigErr) {
      console.error('Signature verification failed:', sigErr.message);
      return json({ error: 'Invalid signature' }, 401);
    }
  } else if (env.STRIPE_VPS_WEBHOOK_SECRET) {
    // Secret is configured but no signature header — reject
    console.error('No stripe-signature header on request');
    return json({ error: 'Missing signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return json({ error: 'Invalid payload' }, 400);
  }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true });
  }

  const session = event.data?.object;
  if (!session) return json({ error: 'No session data' }, 400);

  const metadata = session.metadata || {};
  const plan = (metadata.plan || '').toLowerCase();
  const os = (metadata.os || '').toLowerCase();

  // Only handle VPS checkouts
  if (!PLAN_SPECS[plan] || !OS_TEMPLATES[os]) {
    console.log(`Skipping non-VPS checkout: plan=${plan} os=${os}`);
    return json({ received: true });
  }

  const customerEmail = session.customer_details?.email || session.customer_email;
  const customerName = session.customer_details?.name || '';
  if (!customerEmail) {
    console.error('No customer email in checkout session');
    return json({ error: 'No email' }, 400);
  }

  const siteUrl = env.SITE_URL || 'https://edgeiqlabs.com';
  const spec = PLAN_SPECS[plan];
  const template = OS_TEMPLATES[os];
  const password = generatePassword(16);

  try {
    // 1. Find next available VMID
    const vmid = await findNextVMID(env.PVE_API_TOKEN);

    // 2. Find free IP
    const ip = await findFreeIP(env.PVE_API_TOKEN);
    const sshPort = assignSSHPort(vmid);

    // 3. Create the container
    const hostname = `vps-${plan}-${vmid}`;
    const createParams = {
      vmid: vmid.toString(),
      ostemplate: template,
      hostname: hostname,
      storage: PVE_STORAGE,
      memory: spec.memory.toString(),
      swap: spec.swap.toString(),
      cores: spec.cores.toString(),
      rootfs: `${PVE_STORAGE}:${spec.disk}`,
      net0: `name=eth0,bridge=${PVE_BRIDGE},ip=${ip}/24,gw=${PVE_SUBNET}.1`,
      password: password,
      unprivileged: '1',
      features: 'nesting=1',
      description: `EdgeIQ ${spec.label} | Customer: ${customerEmail} | Plan: ${plan} | OS: ${os}`,
      start: '1',
    };

    await pveRequest(`/nodes/${PVE_NODE}/lxc`, 'POST', env.PVE_API_TOKEN, createParams);
    console.log(`Created CT ${vmid} (${hostname}) at ${ip} for ${customerEmail}`);

    // 4. Create NAT port forward on PVE so customer can reach container from internet
    try {
      const natCmd = `iptables -t nat -A PREROUTING -p tcp --dport ${sshPort} -j DNAT --to-destination ${ip}:22 && netfilter-persistent save`;
      await pveRequest(`/nodes/${PVE_NODE}/execute`, 'POST', env.PVE_API_TOKEN, {
        command: natCmd,
      });
      console.log(`NAT rule added: port ${sshPort} -> ${ip}:22`);
    } catch (natErr) {
      console.error(`NAT rule creation failed (non-fatal): ${natErr.message}`);
      // Continue — container is created, admin can add NAT manually
    }

    // 5. Fix SSH: enable root password login (Debian 12 defaults to prohibit-password)
    try {
      const sshFixCmd = `mkdir -p /etc/ssh/sshd_config.d && printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/99-edgeiq.conf && systemctl restart ssh`;
      await pveRequest(`/nodes/${PVE_NODE}/lxc/${vmid}/exec`, 'POST', env.PVE_API_TOKEN, {
        command: sshFixCmd,
      });
      console.log(`SSH config patched for CT ${vmid}: PermitRootLogin=yes`);
    } catch (sshErr) {
      console.error(`SSH fix failed for CT ${vmid} (non-fatal): ${sshErr.message}`);
    }

    // 6. Send credentials email with PUBLIC IP
    await sendCredentialsEmail(
      env.RESEND_API_KEY, customerEmail, customerName,
      plan, os, PUBLIC_IP, sshPort, password, siteUrl
    );
    console.log(`Sent VPS credentials to ${customerEmail}`);

    // 6. Save VMID + IP back to Stripe subscription metadata for /account/ dashboard
    try {
      const custResp = await fetch(
        `https://api.stripe.com/v1/customers?email=${encodeURIComponent(customerEmail)}&limit=1`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(6000) }
      );
      if (custResp.ok) {
        const custData = await custResp.json();
        const customerId = custData.data?.[0]?.id;
        if (customerId) {
          const subResp = await fetch(
            `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=10`,
            { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(6000) }
          );
          if (subResp.ok) {
            const subData = await subResp.json();
            const vpsSub = (subData.data || []).find(s => {
              const p = s.items?.data?.[0]?.price?.product;
              return ['prod_UaCuF3L5VrZZ84','prod_UaCu8YBqiiZCSZ','prod_UaCu24hkzrKiEh','prod_UaCui9GkAptGyI'].includes(p);
            });
            if (vpsSub) {
              await fetch(`https://api.stripe.com/v1/subscriptions/${vpsSub.id}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `metadata[vmid]=${vmid}&metadata[ip]=${ip}&metadata[plan]=${plan}&metadata[os]=${os}`,
                signal: AbortSignal.timeout(6000),
              });
              console.log(`Saved VMID ${vmid} to Stripe sub ${vpsSub.id}`);
            }
          }
        }
      }
    } catch (metaErr) {
      console.error(`Failed to save metadata to Stripe (non-fatal): ${metaErr.message}`);
    }

    return json({ ok: true, vmid, ip, message: 'Provisioned and emailed' });

  } catch (err) {
    console.error(`VPS provisioning failed for ${customerEmail}:`, err.message);
    // Don't return error to Stripe — it'll retry. Log and alert instead.
    // TODO: Send alert email to admin
    return json({ error: err.message }, 500);
  }
}
