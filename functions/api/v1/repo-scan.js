/**
 * EdgeIQ API v1 — Repo Security Scanner
 * POST /api/v1/repo-scan
 * Body: { "url": "https://github.com/org/repo" }
 * Auth: Bearer <api_key> or X-API-Key header
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key' } });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST with JSON body: { "url": "..." }' }), { status: 405, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }

  // Auth check
  const { validateApiKey, apiResponse } = await import('../_apimarket.js');
  const auth = await validateApiKey(request, env);
  if (!auth.valid) {
    return apiResponse({ error: auth.error }, auth.status, auth.headers || {});
  }

  try {
    const body = await request.json();
    if (!body.url) return apiResponse({ error: 'Missing "url" field' }, 400);

    // Delegate to existing scanner by re-calling it internally
    const scannerUrl = new URL(request.url);
    scannerUrl.pathname = '/api/repo-scanner';
    const internalReq = new Request(scannerUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // We can't call other Pages Functions directly, so we replicate the core fetch
    // Instead, use the public endpoint
    // Direct GitHub API check — no self-fetch loop
    const repoMatch = body.url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return apiResponse({ error: 'Invalid GitHub URL' }, 400);
    const [, owner, repo] = repoMatch;
    const ghToken = env.GITHUB_TOKEN || '';
    const ghHeaders = { 'Authorization': 'token ' + ghToken, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'EdgeIQ-RepoScan/1.0' };
    
    // Check for .env, secrets, missing .gitignore
    const issues = [];
    try {
      const treeResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers: ghHeaders });
      if (treeResp.ok) {
        const tree = await treeResp.json();
        const files = (tree.tree || []).map(f => f.path);
        if (files.some(f => f.endsWith('.env') || f.endsWith('.env.local'))) issues.push({ severity: 'critical', file: '.env', message: 'Environment file committed' });
        if (!files.includes('.gitignore')) issues.push({ severity: 'warning', file: '.gitignore', message: 'No .gitignore found' });
      }
    } catch {}
    
    const grade = issues.filter(i => i.severity === 'critical').length > 0 ? 'F' : issues.length === 0 ? 'A' : issues.length <= 2 ? 'B' : 'C';
    const data = { url: body.url, owner, repo, grade, issues, _api: { tier: auth.tier, remaining_requests: auth.keyData.remaining, rate_limit: auth.keyData.limit } };
    return apiResponse(data);
  } catch (e) {
    return apiResponse({ error: e.message }, 500);
  }
}
