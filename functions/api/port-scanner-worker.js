/**
 * EdgeIQ Labs — Port / Service Exposure Scanner
 * Deploy as: edgeiq-port-scanner.gpalmieri21.workers.dev
 *
 * Free checks: 20 high-risk ports via TCP connect probes.
 * Premium locks: full 65k port sweep, banner/version detection, continuous monitoring.
 */

import { connect } from 'cloudflare:sockets';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PORTS = [
  { port: 21,    label: 'FTP',        severity: 'medium',   message: 'Transmits credentials in plaintext. Replace with SFTP or FTPS.' },
  { port: 22,    label: 'SSH',        severity: 'info',     message: 'Ensure key-based auth only and root login disabled.' },
  { port: 23,    label: 'Telnet',     severity: 'critical', message: 'Unencrypted — must not be internet-accessible. Disable immediately and replace with SSH.' },
  { port: 25,    label: 'SMTP',       severity: 'medium',   message: 'Verify open relay is disabled and authentication is enforced.' },
  { port: 53,    label: 'DNS',        severity: 'info',     message: 'Ensure recursive queries are restricted to authorised resolvers only.' },
  { port: 80,    label: 'HTTP',       severity: 'info',     message: 'Verify all traffic redirects to HTTPS.' },
  { port: 110,   label: 'POP3',       severity: 'medium',   message: 'Use POP3S (port 995) to encrypt email credentials in transit.' },
  { port: 143,   label: 'IMAP',       severity: 'medium',   message: 'Use IMAPS (port 993) to prevent credential interception.' },
  { port: 443,   label: 'HTTPS',      severity: 'info',     message: 'Expected for web services.' },
  { port: 445,   label: 'SMB',        severity: 'critical', message: 'Windows file sharing exposed to internet. Block at firewall immediately — primary ransomware entry point.' },
  { port: 1433,  label: 'MSSQL',      severity: 'high',     message: 'Microsoft SQL Server must never be directly internet-accessible. Restrict to VPN.' },
  { port: 1521,  label: 'Oracle DB',  severity: 'high',     message: 'Restrict to VPN or application tier only.' },
  { port: 3306,  label: 'MySQL',      severity: 'high',     message: 'Restrict to your application server IP and block all other access at firewall.' },
  { port: 3389,  label: 'RDP',        severity: 'critical', message: 'Restrict to VPN-only immediately — top ransomware and brute-force entry point.' },
  { port: 5432,  label: 'PostgreSQL', severity: 'high',     message: 'Bind to localhost and route access through VPN or SSH tunnel.' },
  { port: 5900,  label: 'VNC',        severity: 'critical', message: 'Typically unencrypted. Block at firewall and use a VPN for remote access instead.' },
  { port: 6379,  label: 'Redis',      severity: 'high',     message: 'Often deployed without authentication. Bind to 127.0.0.1 and set requirepass.' },
  { port: 8080,  label: 'HTTP-Alt',   severity: 'info',     message: 'Verify this is intentional and not a development server exposed in production.' },
  { port: 8443,  label: 'HTTPS-Alt',  severity: 'info',     message: 'Alternate HTTPS port — verify service is expected.' },
  { port: 27017, label: 'MongoDB',    severity: 'high',     message: 'Historically deployed without authentication. Block at firewall immediately.' },
];

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function probePort(hostname, port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2200);
    try {
      const socket = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });
      socket.opened.then(() => {
        clearTimeout(timer);
        socket.close().catch(() => {});
        resolve(true);
      }).catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    let body;
    try { body = await request.json(); } catch {
      return jsonResp({ error: 'Invalid JSON body' }, 400);
    }

    let target = (body.target || '').trim();
    if (!target) return jsonResp({ error: 'target is required' }, 400);
    target = target.replace(/^https?:\/\//i, '').split('/')[0];
    if (!target) return jsonResp({ error: 'Invalid target' }, 400);

    const findings = [];
    function add(severity, type, message) { findings.push({ severity, type, message }); }

    // Probe all 20 ports in parallel
    const results = await Promise.allSettled(
      PORTS.map(p => probePort(target, p.port).then(open => ({ ...p, open })))
    );

    const openPorts = [];
    const closedLabels = [];

    results.forEach(r => {
      if (r.status !== 'fulfilled') return;
      const { port, label, severity, message, open } = r.value;
      if (open) {
        openPorts.push({ port, label, severity });
        add(severity, `PORT_${port}_${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
          `Port ${port} (${label}) open — ${message}`);
      } else {
        closedLabels.push(`${label} (${port})`);
      }
    });

    if (closedLabels.length > 0) {
      add('info', 'PORTS_CLOSED',
        `${closedLabels.length} high-risk ports probed and closed: ${closedLabels.join(', ')}.`);
    }

    // Locked upsells
    add('locked', 'FULL_PORT_RANGE_SCAN',
      `Upgrade to Port Scanner Pro to sweep all 65,535 ports and detect non-standard service exposure.`);
    add('locked', 'SERVICE_VERSION_DETECTION',
      `Upgrade to Port Scanner Pro for service banner grabbing and version fingerprinting — identify outdated and vulnerable service versions.`);
    add('locked', 'CONTINUOUS_PORT_MONITORING',
      `Upgrade to Port Scanner Pro to be alerted the moment a new port opens on your infrastructure.`);

    // Scoring
    let deductions = 0;
    findings.forEach(f => {
      if (f.severity === 'critical') deductions += 40;
      else if (f.severity === 'high') deductions += 20;
      else if (f.severity === 'medium') deductions += 10;
    });
    const score = Math.max(0, 100 - deductions);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

    const critCount = openPorts.filter(p => p.severity === 'critical').length;
    const highCount = openPorts.filter(p => p.severity === 'high').length;
    const parts = [`${PORTS.length} ports scanned`, `${openPorts.length} open`];
    if (critCount > 0) parts.push(`${critCount} critical`);
    if (highCount > 0) parts.push(`${highCount} high`);
    parts.push('3 deep checks locked');

    return jsonResp({ hostname: target, grade, score, summary: parts.join(' · '), findings });
  },
};
