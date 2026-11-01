/**
 * EdgeIQ — License Audit (SBOM / Copyleft Risk Scanner)
 * POST /api/license-audit
 * Body: { url: "https://github.com/owner/repo" } or { manifest: "...package.json content..." }
 *
 * Fetches package.json from GitHub raw or accepts direct upload.
 * Resolves each dependency against the npm registry to get its license.
 * Returns A-F graded report with Safe/Caution/Danger breakdown.
 *
 * Free tier: summary counts + top conflicts.
 * Paid tier: full SBOM export + remediation plan (future).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// License classification
const DANGER_LICENSES = ['GPL-2.0', 'GPL-3.0', 'AGPL-1.0', 'AGPL-3.0', 'SSPL-1.0', 'EUPL-1.1', 'EUPL-1.2', 'OSL-3.0', 'CPAL-1.0', 'RPSL-1.0'];
const CAUTION_LICENSES = ['LGPL-2.1', 'LGPL-3.0', 'MPL-2.0', 'CDDL-1.0', 'CDDL-1.1', 'EPL-1.0', 'EPL-2.0', 'APSL-2.0', 'CPL-1.0', 'MS-RL'];
const SAFE_LICENSES = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'WTFPL', 'Zlib', 'BlueOak-1.0.0', '0BSD', 'Artistic-2.0', 'Python-2.0', 'PSF-2.0'];

function classifyLicense(licenseStr) {
  if (!licenseStr || licenseStr === 'UNKNOWN' || licenseStr === '') return { category: 'unknown', risk: 'caution' };
  const upper = licenseStr.toUpperCase().trim();

  // Check danger first (GPL before LGPL)
  for (const d of DANGER_LICENSES) {
    if (upper.includes(d.toUpperCase()) || upper === d.toUpperCase()) {
      return { category: 'danger', risk: 'critical', license: licenseStr };
    }
  }
  for (const c of CAUTION_LICENSES) {
    if (upper.includes(c.toUpperCase()) || upper === c.toUpperCase()) {
      return { category: 'caution', risk: 'medium', license: licenseStr };
    }
  }
  for (const s of SAFE_LICENSES) {
    if (upper.includes(s.toUpperCase()) || upper === s.toUpperCase()) {
      return { category: 'safe', risk: 'none', license: licenseStr };
    }
  }

  // Fallback heuristics
  if (upper.includes('GPL') && !upper.includes('LGPL')) return { category: 'danger', risk: 'critical', license: licenseStr };
  if (upper.includes('LGPL') || upper.includes('MPL') || upper.includes('CDDL') || upper.includes('EPL')) return { category: 'caution', risk: 'medium', license: licenseStr };
  if (upper.includes('BSD') || upper.includes('MIT') || upper.includes('APACHE') || upper.includes('ISC')) return { category: 'safe', risk: 'none', license: licenseStr };

  return { category: 'unknown', risk: 'low', license: licenseStr };
}

function computeGrade(deps, safeCount, cautionCount, dangerCount, unknownCount) {
  const total = deps.length || 1;
  const dangerPct = dangerCount / total;
  const cautionPct = cautionCount / total;
  const unknownPct = unknownCount / total;

  let score = 100;
  score -= dangerCount * 25;   // Each copyleft dep is a major hit
  score -= cautionCount * 8;   // Weak copyleft is moderate
  score -= unknownCount * 5;   // Unknowns need manual review
  score = Math.max(0, Math.min(100, score));

  let grade;
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 35) grade = 'D';
  else grade = 'F';

  return { grade, score };
}

async function fetchNpmLicense(pkgName) {
  try {
    // Strip version range chars for registry lookup
    const clean = pkgName.replace(/^@/, '@').split('@')[0] || pkgName;
    const name = pkgName.startsWith('@') ? pkgName.split('/').slice(0, 2).join('/') : pkgName.split('/')[0];

    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`, {
      headers: { 'User-Agent': 'EdgeIQ-LicenseAudit/1.0', 'Accept': 'application/json' },
      cf: { timeout: 4000 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    // npm stores license in various places
    return data.license || (data.licenses && data.licenses[0] && data.licenses[0].type) || null;
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await context.request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let packageJson = null;
  let repoUrl = '';

  // Option 1: Direct manifest upload
  if (body.manifest) {
    try {
      packageJson = typeof body.manifest === 'string' ? JSON.parse(body.manifest) : body.manifest;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid package.json format' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  }

  // Option 2: GitHub URL
  if (!packageJson && body.url) {
    repoUrl = body.url.trim();
    // Extract owner/repo from various GitHub URL formats
    const match = repoUrl.match(/github\.com\/([^/]+\/[^/]+)/);
    if (!match) {
      return new Response(JSON.stringify({ error: 'Provide a valid GitHub URL (e.g., https://github.com/owner/repo)' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    const repoPath = match[1].replace(/\.git$/, '');
    const branch = body.branch || 'main';

    // Try main first, fall back to master
    let rawUrl = `https://raw.githubusercontent.com/${repoPath}/${branch}/package.json`;
    try {
      let res = await fetch(rawUrl, {
        headers: { 'User-Agent': 'EdgeIQ-LicenseAudit/1.0' },
        cf: { timeout: 6000 },
      });
      if (!res.ok && branch === 'main') {
        rawUrl = `https://raw.githubusercontent.com/${repoPath}/master/package.json`;
        res = await fetch(rawUrl, {
          headers: { 'User-Agent': 'EdgeIQ-LicenseAudit/1.0' },
          cf: { timeout: 6000 },
        });
      }
      if (!res.ok) {
        return new Response(JSON.stringify({
          error: 'No package.json found in this repository',
          note: 'This tool currently supports npm/Node.js projects. Python and Rust support coming soon.',
        }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      packageJson = await res.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: `Failed to fetch package.json: ${e.message}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  }

  if (!packageJson) {
    return new Response(JSON.stringify({ error: 'Provide either a GitHub URL or a package.json manifest' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Merge dependencies + devDependencies
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  const depNames = Object.keys(allDeps);
  if (depNames.length === 0) {
    return new Response(JSON.stringify({
      grade: 'A', score: 100,
      totalDeps: 0, safe: 0, caution: 0, danger: 0, unknown: 0,
      results: [], recommendations: [{ priority: 'info', text: 'No dependencies found. This project has zero supply chain license risk.' }],
      projectName: packageJson.name || 'unknown',
      checkedAt: new Date().toISOString(),
    }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Cap at 50 deps for free tier to avoid timeout
  const scanLimit = 50;
  const toScan = depNames.slice(0, scanLimit);
  const truncated = depNames.length > scanLimit;

  // Resolve licenses in parallel (batches of 10 to avoid rate limits)
  const results = [];
  const batchSize = 10;
  for (let i = 0; i < toScan.length; i += batchSize) {
    const batch = toScan.slice(i, i + batchSize);
    const resolved = await Promise.allSettled(
      batch.map(async (name) => {
        const license = await fetchNpmLicense(name);
        const classification = classifyLicense(license);
        return {
          name,
          version: allDeps[name],
          license: license || 'Unknown',
          ...classification,
        };
      })
    );
    for (const r of resolved) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ name: 'unknown', version: '', license: 'Error', category: 'unknown', risk: 'low' });
    }
  }

  // Tally
  const safeCount = results.filter(r => r.category === 'safe').length;
  const cautionCount = results.filter(r => r.category === 'caution').length;
  const dangerCount = results.filter(r => r.category === 'danger').length;
  const unknownCount = results.filter(r => r.category === 'unknown').length;

  const { grade, score } = computeGrade(results, safeCount, cautionCount, dangerCount, unknownCount);

  // Build recommendations
  const recommendations = [];
  const dangerDeps = results.filter(r => r.category === 'danger');
  const cautionDeps = results.filter(r => r.category === 'caution');

  if (dangerDeps.length > 0) {
    recommendations.push({
      priority: 'critical',
      text: `${dangerDeps.length} dependenc${dangerDeps.length === 1 ? 'y' : 'ies'} use strong copyleft licenses (GPL/AGPL). If your project is proprietary, these may require you to open-source your entire codebase.`,
      deps: dangerDeps.slice(0, 5).map(d => `${d.name} (${d.license})`),
    });
  }
  if (cautionDeps.length > 0) {
    recommendations.push({
      priority: 'high',
      text: `${cautionDeps.length} dependenc${cautionDeps.length === 1 ? 'y' : 'ies'} use weak copyleft licenses (LGPL/MPL/EPL). These allow linking but require modifications to the dependency itself to be shared.`,
      deps: cautionDeps.slice(0, 5).map(d => `${d.name} (${d.license})`),
    });
  }
  if (unknownCount > 0) {
    recommendations.push({
      priority: 'medium',
      text: `${unknownCount} dependenc${unknownCount === 1 ? 'y' : 'ies'} have no declared license. Unlicensed code is legally "all rights reserved" — you may not have the right to use it at all.`,
    });
  }
  if (dangerCount === 0 && cautionCount === 0 && unknownCount === 0) {
    recommendations.push({
      priority: 'info',
      text: 'All dependencies use permissive licenses (MIT, Apache, BSD, ISC). No copyleft risk detected.',
    });
  }
  if (truncated) {
    recommendations.push({
      priority: 'info',
      text: `Scanned ${scanLimit} of ${depNames.length} dependencies. Upgrade to Pro for full SBOM analysis.`,
    });
  }

  // Sort results: danger first, then caution, then unknown, then safe
  const sortOrder = { danger: 0, caution: 1, unknown: 2, safe: 3 };
  results.sort((a, b) => (sortOrder[a.category] || 3) - (sortOrder[b.category] || 3));

  const response = {
    projectName: packageJson.name || repoUrl || 'uploaded-manifest',
    repoUrl: repoUrl || null,
    grade,
    score,
    totalDeps: depNames.length,
    scannedDeps: results.length,
    safe: safeCount,
    caution: cautionCount,
    danger: dangerCount,
    unknown: unknownCount,
    results,
    recommendations,
    truncated,
    checkedAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(response), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
