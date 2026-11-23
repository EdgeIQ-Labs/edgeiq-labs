/**
 * EdgeIQ — AI Search Visibility / GEO Audit Checker
 * GET /api/geo-check?domain=example.com
 *
 * Checks how visible a website is to AI search engines (ChatGPT, Perplexity,
 * Google AI Overviews). Evaluates structured data, FAQ schema, entity markup,
 * citation readiness, and content structure.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch { return null; }
}

export async function onRequestGet(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').split('/')[0].split('?')[0];

  if (!domain || !domain.includes('.') || domain.length < 4) {
    return Response.json({ error: 'Invalid domain' }, { status: 400, headers: CORS });
  }

  // Fetch the page HTML
  const resp = await fetchWithTimeout(`https://${domain}/`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeIQBot/1.0)' }
  });

  if (!resp || resp.status >= 400) {
    return Response.json({
      domain,
      error: 'Could not reach site over HTTPS',
      score: 0,
      grade: 'F',
      checks: []
    }, { headers: CORS });
  }

  const html = await resp.text();
  const checks = [];

  // ── 1. JSON-LD Structured Data ──────────────────────────────────────────────
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const jsonLdBlocks = [];
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try { jsonLdBlocks.push(JSON.parse(match[1])); } catch {}
  }
  const hasJsonLd = jsonLdBlocks.length > 0;
  const jsonLdTypes = jsonLdBlocks.flatMap(b => Array.isArray(b) ? b.map(x => x['@type']) : [b['@type']]).filter(Boolean);
  checks.push({
    name: 'JSON-LD Structured Data',
    ok: hasJsonLd,
    detail: hasJsonLd
      ? `Found ${jsonLdBlocks.length} JSON-LD block(s): ${jsonLdTypes.join(', ')}`
      : 'No JSON-LD found. AI engines rely on structured data to understand your business.',
    level: hasJsonLd ? 'pass' : 'fail'
  });

  // ── 2. FAQ Schema ───────────────────────────────────────────────────────────
  const hasFaqSchema = jsonLdTypes.some(t => String(t).toLowerCase().includes('faqpage'));
  const hasFaqHeadings = /<h[23][^>]*>.*?(faq|frequently asked|common questions).*?<\/h[23]>/i.test(html);
  checks.push({
    name: 'FAQ Schema / Section',
    ok: hasFaqSchema || hasFaqHeadings,
    warn: !hasFaqSchema && hasFaqHeadings,
    detail: hasFaqSchema
      ? 'FAQPage schema detected — AI engines directly cite FAQ answers.'
      : hasFaqHeadings
        ? 'FAQ section found but no FAQPage schema. Add JSON-LD to get cited by AI.'
        : 'No FAQ content or schema found. FAQs are the #1 way AI engines cite your page.',
    level: hasFaqSchema ? 'pass' : (hasFaqHeadings ? 'warn' : 'fail')
  });

  // ── 3. Organization / LocalBusiness Entity ──────────────────────────────────
  const entityTypes = ['Organization', 'LocalBusiness', 'Corporation', 'Person', 'Brand'];
  const hasEntity = jsonLdTypes.some(t => entityTypes.some(e => String(t).toLowerCase().includes(e.toLowerCase())));
  checks.push({
    name: 'Entity Markup (Organization)',
    ok: hasEntity,
    detail: hasEntity
      ? 'Entity type defined — AI search engines can identify your brand in knowledge graphs.'
      : 'No Organization/LocalBusiness schema. AI engines cannot reliably attribute content to your brand.',
    level: hasEntity ? 'pass' : 'fail'
  });

  // ── 4. Open Graph + Twitter Cards ──────────────────────────────────────────
  const ogTitle = /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.test(html);
  const ogDesc = /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i.test(html);
  const twCard = /<meta[^>]*name=["']twitter:card["']/i.test(html);
  const ogCount = [ogTitle, ogDesc, twCard].filter(Boolean).length;
  checks.push({
    name: 'Open Graph & Social Meta',
    ok: ogCount >= 2,
    warn: ogCount === 1,
    detail: `${ogCount}/3 social meta tags found (og:title, og:description, twitter:card). AI engines use these for link citations.`,
    level: ogCount >= 2 ? 'pass' : (ogCount === 1 ? 'warn' : 'fail')
  });

  // ── 5. Semantic HTML Structure ──────────────────────────────────────────────
  const hasArticle = /<article/i.test(html);
  const hasMain = /<main/i.test(html);
  const hasNav = /<nav/i.test(html);
  const semanticCount = [hasArticle, hasMain, hasNav].filter(Boolean).length;
  checks.push({
    name: 'Semantic HTML (<main>, <article>, <nav>)',
    ok: semanticCount >= 2,
    warn: semanticCount === 1,
    detail: `${semanticCount}/3 semantic elements found. AI parsers extract content from <main> and <article> more reliably than generic <div> soup.`,
    level: semanticCount >= 2 ? 'pass' : (semanticCount === 1 ? 'warn' : 'fail')
  });

  // ── 6. Heading Hierarchy ────────────────────────────────────────────────────
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
  const goodH1 = h1Count === 1;
  checks.push({
    name: 'Heading Hierarchy (H1/H2)',
    ok: goodH1 && h2Count > 0,
    warn: !goodH1 && h1Count > 0,
    detail: `${h1Count} H1 tag(s), ${h2Count} H2 tag(s). AI engines use headings to build content outlines. Exactly 1 H1 with multiple H2s is ideal.`,
    level: (goodH1 && h2Count > 0) ? 'pass' : (!goodH1 ? 'warn' : 'fail')
  });

  // ── 7. robots.txt Accessibility ─────────────────────────────────────────────
  const robotsResp = await fetchWithTimeout(`https://${domain}/robots.txt`);
  const hasRobots = !!robotsResp && robotsResp.status === 200;
  let aiBotBlocked = false;
  if (hasRobots) {
    const robotsText = await robotsResp.text();
    aiBotBlocked = /user-agent:\s*(GPTBot|ChatGPT-User|CCBot|anthropic-ai|PerplexityBot|Google-Extended)/i.test(robotsText)
      && /disallow:\s*\//i.test(robotsText);
  }
  checks.push({
    name: 'robots.txt & AI Bot Access',
    ok: hasRobots && !aiBotBlocked,
    warn: hasRobots && aiBotBlocked,
    detail: !hasRobots
      ? 'No robots.txt found. Some AI crawlers may skip your site entirely without one.'
      : aiBotBlocked
        ? 'robots.txt blocks AI training bots (GPTBot, CCBot, etc.). Your content will NOT appear in AI answers.'
        : 'robots.txt present and allows AI bot crawling. Good for AI visibility.',
    level: !hasRobots ? 'fail' : (aiBotBlocked ? 'warn' : 'pass')
  });

  // ── 8. Sitemap Reference ────────────────────────────────────────────────────
  const sitemapInRobots = hasRobots ? /sitemap:/i.test(await (await fetchWithTimeout(`https://${domain}/robots.txt`)).text()) : false;
  const sitemapXml = await fetchWithTimeout(`https://${domain}/sitemap.xml`);
  const hasSitemap = sitemapInRobots || (!!sitemapXml && sitemapXml.status === 200);
  checks.push({
    name: 'XML Sitemap',
    ok: hasSitemap,
    detail: hasSitemap
      ? 'Sitemap found — helps AI discovery engines crawl all pages efficiently.'
      : 'No sitemap.xml or sitemap reference in robots.txt. AI crawlers may miss deep pages.',
    level: hasSitemap ? 'pass' : 'fail'
  });

  // ── 9. Canonical URL ────────────────────────────────────────────────────────
  const hasCanonical = /<link[^>]*rel=["']canonical["']/i.test(html);
  checks.push({
    name: 'Canonical URL Tag',
    ok: hasCanonical,
    detail: hasCanonical
      ? 'Canonical tag set — prevents duplicate content confusion for AI citation engines.'
      : 'No canonical tag. AI engines may cite the wrong URL or skip your page as duplicate.',
    level: hasCanonical ? 'pass' : 'fail'
  });

  // ── 10. Content Length (AI Citation Threshold) ─────────────────────────────
  // Strip tags for rough word count
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/\s+/g, ' ')
                       .trim();
  const wordCount = textOnly.split(' ').filter(w => w.length > 1).length;
  checks.push({
    name: 'Content Depth',
    ok: wordCount >= 500,
    warn: wordCount >= 200 && wordCount < 500,
    detail: `~${wordCount.toLocaleString()} words of visible content. AI engines prefer 500+ words to find citable passages. Thin content gets skipped.`,
    level: wordCount >= 500 ? 'pass' : (wordCount >= 200 ? 'warn' : 'fail')
  });

  // ── Score Calculation ───────────────────────────────────────────────────────
  const totalChecks = checks.length;
  const passCount = checks.filter(c => c.level === 'pass').length;
  const warnCount = checks.filter(c => c.level === 'warn').length;
  // Pass = full point, Warn = half point, Fail = 0
  const score = Math.round(((passCount + (warnCount * 0.5)) / totalChecks) * 100);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  return Response.json({
    domain,
    score,
    grade,
    checks,
    summary: {
      total: totalChecks,
      pass: passCount,
      warn: warnCount,
      fail: totalChecks - passCount - warnCount
    }
  }, { headers: { ...CORS, 'Cache-Control': 'public, max-age=120' } });
}
