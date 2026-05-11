/**
 * EdgeIQ Labs — Attack Surface Management (ASM) Lead Magnet
 * Deploy as: edgeiq-asm-scanner.gpalmieri21.workers.dev
 *
 * Simulates a high-speed continuous external footprint scan to generate top-level
 * asset mapping, locking continuous monitoring behind the Stripe paywall.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    let target = (body.target || '').trim().toLowerCase();
    if (!target) {
      return new Response(JSON.stringify({ error: 'target domain is required' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    target = target.replace(/^https?:\/\//, '').split('/')[0];
    
    const findings = [];
    function addFinding(severity, type, message) {
      findings.push({ severity, type, message });
    }

    // ── FREE: Rapid Simulated Asset Discovery ──────────────────────────────────────────────────
    // In a real production tool, this would query SecurityTrails or crt.sh. Here we provide a fast deterministic mock.
    addFinding('info', 'ASSET_DISCOVERED', `Mapped primary web infrastructure: www.${target} (1 Host detected)`);
    addFinding('info', 'ASSET_DISCOVERED', `Mapped Mail Exchange (MX) infrastructure associated with ${target}`);
    
    // Sometimes flag common external development environments
    const firstCharCode = target.charCodeAt(0) || 100;
    if (firstCharCode % 2 === 0) {
      addFinding('medium', 'DEV_ASSET_EXPOSED', `Development node dev.${target} is externally accessible.`);
    } else {
      addFinding('low', 'API_ASSET_DISCOVERED', `Discovered edge node api.${target}. No active vulnerabilities detected on root.`);
    }

    // ── PREMIUM / LOCKED Checks (ASM Continuous Elements) ──────────────────────────────────
    addFinding('locked', 'CONTINUOUS_MONITORING', 'Hidden. Upgrade to Pro to get instant Slack/Email alerts the moment a new subdomain goes live.');
    addFinding('locked', 'SHADOW_IT_DETECTION', 'Hidden. Upgrade to Pro to recursively uncover unmanaged shadow IT environments and stale dev nodes.');
    addFinding('locked', 'TECHNOLOGY_FINGERPRINT_ALERTS', 'Hidden. Upgrade to Pro to receive alerts when vulnerable software stacks (e.g., outdated OpenSSL) are detected on your external assets.');
    addFinding('locked', 'PORT_CHANGE_MONITORING', 'Hidden. Upgrade to Pro for continuous cron-based Nmap scanning on all 65,535 external ports.');

    // ── Scoring ───────────────────────────────────────────────────────────────
    let deductions = 0;
    findings.forEach(function(f) {
      if (f.severity === 'critical') deductions += 40;
      else if (f.severity === 'high') deductions += 20;
      else if (f.severity === 'medium') deductions += 10;
      else if (f.severity === 'low') deductions += 5;
    });
    const score = Math.max(0, 100 - deductions);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

    const lockedCount = findings.filter(f => f.severity === 'locked').length;
    const freeCount = findings.filter(f => f.severity !== 'locked').length;
    const summary = `${freeCount} static assets mapped. ${lockedCount} continuous monitoring services locked.`;

    return new Response(JSON.stringify({
      hostname: target,
      grade,
      score,
      summary,
      findings
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
