/**
 * EdgeIQ Labs — CSPM / Cloud Exposed Assets Scanner
 * Deploy as: edgeiq-cspm-scanner.gpalmieri21.workers.dev
 *
 * Performs external posture checks to see if cloud infrastructure associated with the domain
 * has been left open to the public (e.g. S3 Public List).
 *
 * Includes "locked" (Premium) checks.
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
      return new Response(JSON.stringify({ error: 'target domain/company is required' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Strip http/https and paths if user entered a full URL
    target = target.replace(/^https?:\/\//, '').split('/')[0];
    
    // Extract base name for permutations (e.g. "example" from "example.com")
    let baseName = target.split('.')[0];
    
    const findings = [];
    function addFinding(severity, type, message) {
      findings.push({ severity, type, message });
    }

    // ── FREE: AWS S3 Public List Check ──────────────────────────────────────────────────
    // Permutations for bucket names
    const prefixes = [baseName, baseName + '-prod', baseName + '-assets', target.replace(/\./g, '-')];
    
    // We run checks in parallel up to a certain subset
    const s3Checks = prefixes.map(async (bucket) => {
      const url = 'https://' + bucket + '.s3.amazonaws.com/';
      try {
        const resp = await fetch(url, { method: 'GET', cf: { timeout: 3000 } });
        if (resp.status === 200) {
          const text = await resp.text();
          if (text.includes('<ListBucketResult>')) {
            addFinding('critical', 'AWS_PUBLIC_S3', 'Bucket exposed: ' + bucket + '.s3.amazonaws.com allows public read/list access.');
          }
        } else if (resp.status === 403) {
           // We found a bucket, but access is denied (secure)
           addFinding('info', 'AWS_S3_DETECTED', 'Bucket ' + bucket + '.s3.amazonaws.com detected but secured.');
        }
      } catch { /* ignore timeouts/dns failures */ }
    });
    
    await Promise.all(s3Checks);
    
    // ── FREE: GCP Bucket Detection ──────────────────────────────────────────────────────
    const gcpUrl = 'https://storage.googleapis.com/' + baseName;
    try {
      const gcpResp = await fetch(gcpUrl, { method: 'GET', cf: { timeout: 3000 } });
      if (gcpResp.status === 200) {
        addFinding('critical', 'GCP_PUBLIC_BUCKET', 'Public GCP bucket discovered at ' + gcpUrl);
      }
    } catch { }

    // ── PREMIUM / LOCKED Checks ─────────────────────────────────────────────────────────
    addFinding('locked', 'AZURE_BLOB_EXPOSURE', 'Hidden. Upgrade to Pro to check if Microsoft Azure Blob containers are publicly accessible.');
    addFinding('locked', 'ELASTICSEARCH_EXPOSURE', 'Hidden. Upgrade to Pro to deep-scan metadata searching for exposed Elasticsearch/Kibana endpoints.');
    addFinding('locked', 'IAM_ROLE_LEAKAGE', 'Hidden. Upgrade to Pro to search public infrastructure definitions for leaked Identity Access roles.');

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
    const summary = freeCount + ' findings evaluated, ' + lockedCount + ' deep asset checks locked.';

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
