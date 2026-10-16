/**
 * EdgeIQ Labs — Repo Security Scanner
 * Deploy as: Cloudflare Pages Function at /api/repo-scanner
 *
 * Analyzes a GitHub repository for security posture:
 * .env files committed, API keys in code, missing .gitignore patterns,
 * and Supabase/PostgREST RLS policy detection.
 * Free tier: public repos only, surface-level checks.
 * Premium: private repos via token, deep dependency audit, CI integration.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Patterns that scream "leaked secret" in source code
const SECRET_PATTERNS = [
  { regex: /(?:sk_live_|sk_test_|rk_live_|rk_test_)[a-zA-Z0-9]{20,}/g, label: 'STRIPE_KEY', desc: 'Stripe API key' },
  { regex: /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g, label: 'GITHUB_TOKEN', desc: 'GitHub personal access token' },
  { regex: /AKIA[0-9A-Z]{16}/g, label: 'AWS_ACCESS_KEY', desc: 'AWS Access Key ID' },
  { regex: /xox[baprs]-[a-zA-Z0-9\-]{10,}/g, label: 'SLACK_TOKEN', desc: 'Slack token' },
  { regex: /AIza[0-9A-Za-z\-_]{35}/g, label: 'GOOGLE_API_KEY', desc: 'Google API key' },
  { regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g, label: 'JWT_SECRET', desc: 'Hardcoded JWT token' },
  { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: 'PRIVATE_KEY', desc: 'Private key block' },
  { regex: /(?:(?:password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|client_secret)\s*[:=]\s*['"])[^'"]{4,}['"]/gi, label: 'HARDCODED_SECRET', desc: 'Hardcoded secret assignment' },
];

// Files that should almost always be in .gitignore
const EXPECTED_GITIGNORE_ENTRIES = [
  '.env', '.env.local', '.env.production',
  'node_modules/', 'dist/', 'build/',
  '*.log', '.DS_Store',
  '.vscode/', '.idea/',
];

// Supabase / PostgREST indicator paths
const SUPABASE_INDICATORS = [
  'supabase/config.toml', 'supabase/schema.sql',
  'supabase/migrations/', 'db/schema.sql',
];

async function handleRequest(request) {

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

  let rawUrl = (body.url || body.repo || '').trim();
  if (!rawUrl) {
    return new Response(JSON.stringify({ error: 'url is required (e.g. https://github.com/owner/repo)' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Parse owner/repo from various GitHub URL formats
  let owner, repo;
  try {
    const match = rawUrl.match(/github\.com\/([^/]+)\/([^/\s#?]+)/i);
    if (!match) throw new Error('not github');
    owner = match[1];
    repo = match[2].replace(/\.git$/, '');
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid GitHub URL. Provide a link like https://github.com/owner/repo' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const target = `${owner}/${repo}`;
  const findings = [];

  function addFinding(severity, type, message) {
    findings.push({ severity, type, message });
  }

  // ── FREE Check 1: Repo metadata via GitHub API ────────────────────────────
  let repoData = null;
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'User-Agent': 'EdgeIQ-RepoScanner/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
      cf: { timeout: 8000 },
    });
    if (resp.status === 404) {
      return new Response(JSON.stringify({
        repo: target, grade: '?', score: 0,
        summary: 'Repository not found or is private.',
        findings: [{ severity: 'critical', type: 'REPO_NOT_FOUND', message: 'This repository does not exist or is private. Private repo scanning requires a Pro token.' }],
      }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }
    if (resp.ok) {
      repoData = await resp.json();
    }
  } catch (err) {
    addFinding('info', 'API_UNREACHABLE', 'Could not reach GitHub API: ' + err.message);
  }

  if (repoData) {
    // Default branch info
    const defaultBranch = repoData.default_branch || 'main';

    // Check if repo has issues/wiki/pages enabled (attack surface)
    if (repoData.has_wiki) {
      addFinding('low', 'WIKI_ENABLED', 'Repository wiki is enabled. Wikis are often overlooked in security reviews and can contain sensitive internal documentation.');
    }
    if (repoData.has_pages) {
      addFinding('info', 'GH_PAGES_ENABLED', 'GitHub Pages is active. Ensure no sensitive data is published via the pages build.');
    }

    // Stale repo check
    if (repoData.updated_at) {
      const daysSince = Math.floor((Date.now() - new Date(repoData.updated_at).getTime()) / 86400000);
      if (daysSince > 365) {
        addFinding('medium', 'STALE_REPO', `Repository was last updated ${daysSince} days ago. Unmaintained repos accumulate vulnerable dependencies without patches.`);
      }
    }

    // ── FREE Check 2: Fetch file tree recursively ─────────────────────────────
    let tree = [];
    try {
      const treeResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
        {
          headers: { 'User-Agent': 'EdgeIQ-RepoScanner/1.0', 'Accept': 'application/vnd.github.v3+json' },
          cf: { timeout: 10000 },
        }
      );
      if (treeResp.ok) {
        const treeData = await treeResp.json();
        if (!treeData.truncated) {
          tree = treeData.tree || [];
        } else {
          addFinding('info', 'TREE_TRUNCATED', 'Repository is too large for full tree analysis. Surface-level scan performed on visible files.');
          tree = treeData.tree || [];
        }
      }
    } catch { /* continue with empty tree */ }

    const filePaths = tree.filter(t => t.type === 'blob').map(t => t.path);
    const dirPaths = tree.filter(t => t.type === 'tree').map(t => t.path);

    // ── FREE Check 3: .env files committed ────────────────────────────────────
    const envFiles = filePaths.filter(p => /(^|\/|\\)\.env(\..*)?$/.test(p) && !p.includes('.example'));
    if (envFiles.length > 0) {
      addFinding('critical', 'ENV_COMMITTED',
        `${envFiles.length} .env file(s) are committed to the repository: ${envFiles.slice(0, 5).join(', ')}${envFiles.length > 5 ? '...' : ''}. These likely contain secrets, API keys, or database credentials exposed to anyone who can read this repo.`);
    }

    // Also flag .env.example with suspicious content hints
    const envExamples = filePaths.filter(p => /\.env\.(example|sample|template)/i.test(p));
    if (envExamples.length > 0) {
      addFinding('info', 'ENV_EXAMPLE_PRESENT',
        `.env example file(s) found: ${envExamples.join(', ')}. Ensure they contain placeholder values only, not real credentials.`);
    }

    // ── FREE Check 4: .gitignore analysis ─────────────────────────────────────
    const gitignorePath = filePaths.find(p => p.toLowerCase() === '.gitignore');
    if (!gitignorePath) {
      addFinding('high', 'NO_GITIGNORE',
        'No .gitignore file found in the repository root. This dramatically increases the risk of accidentally committing secrets, build artifacts, and IDE configuration.');
    } else {
      // Fetch .gitignore contents
      try {
        const giResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/.gitignore?ref=${defaultBranch}`,
          {
            headers: { 'User-Agent': 'EdgeIQ-RepoScanner/1.0', 'Accept': 'application/vnd.github.v3.raw' },
            cf: { timeout: 5000 },
          }
        );
        if (giResp.ok) {
          const giContent = await giResp.text();
          const giLower = giContent.toLowerCase();
          const missing = [];
          for (const entry of EXPECTED_GITIGNORE_ENTRIES) {
            const search = entry.toLowerCase().replace(/\/$/, '');
            if (!giLower.includes(search)) {
              missing.push(entry);
            }
          }
          if (missing.length > 0) {
            addFinding('medium', 'GITIGNORE_GAPS',
              `.gitignore is missing ${missing.length} recommended pattern(s): ${missing.join(', ')}. Add these to prevent accidental secret commits.`);
          } else {
            addFinding('info', 'GITIGNORE_HEALTHY', '.gitignore covers all standard sensitive file patterns.');
          }
        }
      } catch { /* skip */ }
    }

    // ── FREE Check 5: Scan sample files for hardcoded secrets ─────────────────
    // We can't scan every file in a large repo within Workers limits, so we
    // sample up to 30 interesting files (configs, source files, small size)
    const SCANNABLE_EXTENSIONS = /\.(js|ts|jsx|tsx|py|rb|go|java|php|yml|yaml|json|toml|cfg|ini|conf|sh|bash|sql|env|properties)$/i;
    const candidates = filePaths
      .filter(p => SCANNABLE_EXTENSIONS.test(p) && !p.includes('node_modules') && !p.includes('vendor/') && !p.includes('.min.'))
      .slice(0, 30);

    let secretsFound = 0;
    const secretDetails = [];

    for (const filePath of candidates) {
      try {
        const fileResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${defaultBranch}`,
          {
            headers: { 'User-Agent': 'EdgeIQ-RepoScanner/1.0', 'Accept': 'application/vnd.github.v3.raw' },
            cf: { timeout: 4000 },
          }
        );
        if (!fileResp.ok) continue;
        const content = await fileResp.text();

        // Skip binary-looking content
        if (content.includes('\0')) continue;

        for (const pattern of SECRET_PATTERNS) {
          const matches = content.match(pattern.regex);
          if (matches && matches.length > 0) {
            secretsFound += matches.length;
            if (secretDetails.length < 10) {
              secretDetails.push(`${pattern.desc} in ${filePath}`);
            }
          }
        }
      } catch { /* rate limit or timeout, skip */ }
    }

    if (secretsFound > 0) {
      addFinding('critical', 'SECRETS_IN_CODE',
        `Found ${secretsFound} potential secret(s) across ${candidates.length} scanned files. Matches include: ${secretDetails.slice(0, 5).join('; ')}. Rotate any exposed credentials immediately.`);
    } else if (candidates.length > 0) {
      addFinding('info', 'NO_SECRETS_DETECTED',
        `Scanned ${candidates.length} source files — no obvious hardcoded secrets detected. Note: deep scanning of all files requires Pro.`);
    }

    // ── FREE Check 6: Supabase / PostgREST RLS detection ─────────────────────
    const hasSupabase = SUPABASE_INDICATORS.some(ind =>
      filePaths.some(p => p.toLowerCase().includes(ind.toLowerCase())) ||
      dirPaths.some(d => d.toLowerCase().includes(ind.toLowerCase()))
    );

    if (hasSupabase) {
      addFinding('info', 'SUPABASE_DETECTED',
        'This repository appears to use Supabase or PostgREST. Checking for Row Level Security (RLS) policies...');

      // Look for migration files mentioning RLS
      const migrationFiles = filePaths.filter(p => /supabase\/migrations\/.*\.sql$/i.test(p) || /db\/migrations\/.*\.sql$/i.test(p));
      let rlsEnabled = false;
      let rlsCount = 0;

      for (const migFile of migrationFiles.slice(0, 10)) {
        try {
          const migResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${migFile}?ref=${defaultBranch}`,
            {
              headers: { 'User-Agent': 'EdgeIQ-RepoScanner/1.0', 'Accept': 'application/vnd.github.v3.raw' },
              cf: { timeout: 4000 },
            }
          );
          if (migResp.ok) {
            const sql = await migResp.text();
            const rlsMatches = sql.match(/ALTER\s+TABLE\s+\S+\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi);
            if (rlsMatches) {
              rlsEnabled = true;
              rlsCount += rlsMatches.length;
            }
            // Also check for CREATE POLICY
            const policyMatches = sql.match(/CREATE\s+POLICY/gi);
            if (policyMatches) {
              rlsCount += policyMatches.length;
            }
          }
        } catch { /* skip */ }
      }

      if (rlsEnabled && rlsCount > 0) {
        addFinding('info', 'RLS_POLICIES_FOUND',
          `Detected ${rlsCount} RLS policy/policies in migrations. Row Level Security appears to be configured.`);
      } else if (migrationFiles.length > 0 && !rlsEnabled) {
        addFinding('high', 'RLS_MISSING',
          'Supabase/PostgREST detected but no ENABLE ROW LEVEL SECURITY statements found in migrations. Without RLS, any authenticated user can potentially read/write all rows in your tables.');
      } else if (migrationFiles.length === 0) {
        addFinding('medium', 'NO_MIGRATIONS',
          'Supabase project detected but no migration files found. Database schema may be managed outside version control, which risks unreviewed security changes.');
      }
    }

    // ── FREE Check 7: CI/CD security config ──────────────────────────────────
    const ghActions = filePaths.filter(p => p.startsWith('.github/workflows/') && p.endsWith('.yml'));
    if (ghActions.length > 0) {
      // Check for pinned action versions vs @main/@master
      let unpinnedActions = 0;
      for (const wf of ghActions.slice(0, 5)) {
        try {
          const wfResp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${wf}?ref=${defaultBranch}`,
            {
              headers: { 'User-Agent': 'EdgeIQ-RepoScanner/1.0', 'Accept': 'application/vnd.github.v3.raw' },
              cf: { timeout: 4000 },
            }
          );
          if (wfResp.ok) {
            const wfContent = await wfResp.text();
            const usesMatches = wfContent.match(/uses:\s*[^@\s]+@(main|master)/gi);
            if (usesMatches) unpinnedActions += usesMatches.length;
          }
        } catch { /* skip */ }
      }
      if (unpinnedActions > 0) {
        addFinding('high', 'UNPINNED_ACTIONS',
          `${unpinnedActions} GitHub Action(s) reference @main or @master instead of a pinned SHA. Supply chain attacks can silently modify actions at mutable tags.`);
      } else {
        addFinding('info', 'CI_PRESENT', `${ghActions.length} GitHub Actions workflow(s) detected.`);
      }
    } else {
      addFinding('medium', 'NO_CI_CD',
        'No GitHub Actions workflows detected. Repositories without CI/CD miss automated security testing, linting, and dependency scanning.');
    }
  }

  // ── PREMIUM / LOCKED Checks ─────────────────────────────────────────────────
  addFinding('locked', 'PRIVATE_REPO_SCAN',
    'Hidden. Upgrade to Repo Scanner Pro to scan private repositories using a scoped GitHub token.');
  addFinding('locked', 'DEPENDENCY_AUDIT',
    'Hidden. Upgrade to Repo Scanner Pro to run a full dependency vulnerability audit against package.json, requirements.txt, go.sum, Cargo.lock, and Gemfile.lock.');
  addFinding('locked', 'DEEP_SECRET_SCAN',
    'Hidden. Upgrade to Repo Scanner Pro to scan every file in the repository (not just a sample) using entropy analysis and 50+ secret patterns.');
  addFinding('locked', 'CI_PIPELINE_HARDENING',
    'Hidden. Upgrade to Repo Scanner Pro to analyze CI/CD pipelines for insecure secrets handling, overly permissive GITHUB_TOKEN scopes, and artifact poisoning vectors.');
  addFinding('locked', 'SBOM_GENERATION',
    'Hidden. Upgrade to Repo Scanner Pro to generate a Software Bill of Materials mapping every transitive dependency to known CVEs.');

  // ── Scoring ─────────────────────────────────────────────────────────────────
  let deductions = 0;
  findings.forEach(f => {
    if (f.severity === 'critical') deductions += 30;
    else if (f.severity === 'high') deductions += 15;
    else if (f.severity === 'medium') deductions += 8;
    else if (f.severity === 'low') deductions += 3;
  });
  const score = Math.max(0, 100 - deductions);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

  const lockedCount = findings.filter(f => f.severity === 'locked').length;
  const freeCount = findings.filter(f => f.severity !== 'locked').length;
  const summary = `${freeCount} checks evaluated, ${lockedCount} advanced scans locked.`;

  return new Response(JSON.stringify({
    repo: target,
    grade,
    score,
    summary,
    findings
  }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) { return handleRequest(context.request); }
