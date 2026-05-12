/**
 * EdgeIQ Labs — Docker / Container Image Scanner
 * Deploy as: edgeiq-docker-scanner.gpalmieri21.workers.dev
 *
 * Queries the Docker Hub public API to surface security posture information
 * about any public container image. Premium checks are locked behind paywall.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Known base images with historical CVE problems
const RISKY_BASE_IMAGES = [
  'ubuntu:18.04', 'ubuntu:16.04', 'ubuntu:14.04',
  'debian:8', 'debian:9', 'debian:stretch', 'debian:jessie',
  'centos:6', 'centos:7',
  'node:10', 'node:12', 'node:14',
  'python:2', 'python:3.6', 'python:3.7',
  'alpine:3.10', 'alpine:3.11', 'alpine:3.12',
  'php:7.2', 'php:7.3',
];

// Images that are commonly pulled with sensitive defaults
const HIGH_RISK_IMAGES = ['root', 'kali', 'metasploit', 'sqlmap'];

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

    let image = (body.image || '').trim().toLowerCase();
    if (!image) {
      return new Response(JSON.stringify({ error: 'image name is required (e.g. nginx or library/nginx)' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Normalize: if no slash, assume official library image
    const imageParts = image.split(':');
    const imageTag = imageParts[1] || 'latest';
    let imageRepo = imageParts[0];
    if (!imageRepo.includes('/')) imageRepo = 'library/' + imageRepo;

    const findings = [];
    function addFinding(severity, type, message) {
      findings.push({ severity, type, message });
    }

    // ── FREE Check 1: Docker Hub API metadata ─────────────────────────────────
    let hubData = null;
    try {
      const hubResp = await fetch(
        `https://hub.docker.com/v2/repositories/${imageRepo}/`,
        { method: 'GET', cf: { timeout: 5000 } }
      );
      if (hubResp.ok) {
        hubData = await hubResp.json();
      } else if (hubResp.status === 404) {
        return new Response(JSON.stringify({ error: `Image "${imageRepo}" not found on Docker Hub.` }), {
          status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } else {
        return new Response(JSON.stringify({ error: `Docker Hub returned status ${hubResp.status}. Try again shortly.` }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: 'Failed to reach Docker Hub API.' }), {
        status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const pullCount = hubData.pull_count || 0;
    const starCount = hubData.star_count || 0;
    const isOfficial = hubData.is_official || false;
    const isAutomated = hubData.is_automated || false;
    const lastUpdated = hubData.last_updated ? hubData.last_updated.split('T')[0] : 'unknown';
    const description = hubData.description || '';

    // ── FREE Check 2: Official image status ──────────────────────────────────
    if (!isOfficial) {
      addFinding('medium', 'NOT_OFFICIAL_IMAGE', `This image is not Docker Official — it hasn't been verified by Docker/the publisher. Consider using an official alternative.`);
    } else {
      addFinding('info', 'OFFICIAL_IMAGE', `✅ Image is a Docker Official Image — maintained and regularly scanned by Docker Hub.`);
    }

    // ── FREE Check 3: Latest tag usage ───────────────────────────────────────
    if (imageTag === 'latest') {
      addFinding('high', 'UNPINNED_LATEST_TAG', `Image is pulled with the :latest tag. This prevents reproducible builds and can silently introduce vulnerable layers. Pin to a specific digest or version tag.`);
    }

    // ── FREE Check 4: Stale image check ──────────────────────────────────────
    if (lastUpdated !== 'unknown') {
      const daysSince = Math.floor((Date.now() - new Date(lastUpdated).getTime()) / 86400000);
      if (daysSince > 365) {
        addFinding('high', 'STALE_IMAGE', `Image was last pushed ${daysSince} days ago (${lastUpdated}). Unmaintained images accumulate unpatched OS-level vulnerabilities.`);
      } else if (daysSince > 180) {
        addFinding('medium', 'AGING_IMAGE', `Image was last pushed ${daysSince} days ago. Consider checking for a more recent version.`);
      } else {
        addFinding('info', 'IMAGE_FRESHNESS', `Image was last updated ${daysSince} days ago (${lastUpdated}) — relatively current.`);
      }
    }

    // ── FREE Check 5: High-risk image name detection ──────────────────────────
    for (const risk of HIGH_RISK_IMAGES) {
      if (imageRepo.toLowerCase().includes(risk)) {
        addFinding('critical', 'HIGH_RISK_IMAGE_NAME', `Image name contains "${risk}" - high potential for offensive tooling in runtime environment. Only deploy in isolated, sandboxed environments.`);
        break;
      }
    }

    // ── FREE Check 6: Known risky base image tag ─────────────────────────────
    const normalizedInput = `${imageRepo.replace('library/', '')}:${imageTag}`;
    if (RISKY_BASE_IMAGES.some(r => normalizedInput.startsWith(r.split(':')[0]) && r.includes(`:${imageTag}`))) {
      addFinding('high', 'EOL_BASE_IMAGE', `The tag "${imageTag}" matches a known end-of-life base image version. This image no longer receives security patches.`);
    }

    // ── FREE Check 7: Pull count anomaly (too popular can mean supply chain risk) ──
    if (pullCount > 1000000000) {
      addFinding('info', 'HIGH_PULL_COUNT', `Image has ${(pullCount / 1e9).toFixed(1)}B+ pulls — extremely high usage. Verify the publisher identity to rule out supply chain substitution.`);
    }

    // ── PREMIUM / LOCKED Checks ───────────────────────────────────────────────
    addFinding('locked', 'CVE_LAYER_SCAN', 'Hidden. Upgrade to Container Scanner Pro to run a full CVE scan against the image layers using the Grype vulnerability database.');
    addFinding('locked', 'SBOM_ANALYSIS', 'Hidden. Upgrade to Container Scanner Pro to generate a Software Bill of Materials (SBOM) for this image and map all OS packages to their CVE history.');
    addFinding('locked', 'SECRET_LEAK_SCAN', 'Hidden. Upgrade to Container Scanner Pro to scan the image filesystem for leaked secrets, API keys, and credentials baked into the image layers.');
    addFinding('locked', 'RUNTIME_RISK_PROFILE', 'Hidden. Upgrade to Container Scanner Pro to generate a runtime risk profile: privileged mode usage, root user detection, writable filesystem checks.');

    // ── Scoring ───────────────────────────────────────────────────────────────
    let deductions = 0;
    findings.forEach(f => {
      if (f.severity === 'critical') deductions += 40;
      else if (f.severity === 'high') deductions += 20;
      else if (f.severity === 'medium') deductions += 10;
      else if (f.severity === 'low') deductions += 5;
    });
    const score = Math.max(0, 100 - deductions);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

    const lockedCount = findings.filter(f => f.severity === 'locked').length;
    const freeCount = findings.filter(f => f.severity !== 'locked').length;

    return new Response(JSON.stringify({
      image: `${imageRepo.replace('library/', '')}:${imageTag}`,
      grade,
      score,
      pullCount,
      starCount,
      isOfficial,
      lastUpdated,
      summary: `${freeCount} checks evaluated, ${lockedCount} deep container scans locked.`,
      findings
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
