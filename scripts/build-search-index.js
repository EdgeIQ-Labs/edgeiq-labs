#!/usr/bin/env node
/**
 * Build search-index.json from site HTML files.
 * Run: node scripts/build-search-index.js
 * Output: search-index.json (committed to repo for CF Pages)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'search-index.json');

// Pages to index with metadata
const PAGES = [
  // Free tools
  { url: '/free-ssl-checker/', title: 'SSL Certificate Checker', category: 'Free Tool', description: 'Check SSL/TLS certificate validity, expiry, chain, and configuration for any domain.' },
  { url: '/free-dmarc-checker/', title: 'DMARC Record Checker', category: 'Free Tool', description: 'Validate DMARC DNS records and get enforcement policy recommendations.' },
  { url: '/free-spf-checker/', title: 'SPF Record Checker', category: 'Free Tool', description: 'Verify SPF DNS records for email authentication and deliverability.' },
  { url: '/free-subdomain-scanner/', title: 'Subdomain Scanner', category: 'Free Tool', description: 'Discover subdomains via DNS enumeration and certificate transparency logs.' },
  { url: '/free-repo-scanner/', title: 'Repository Security Scanner', category: 'Free Tool', description: 'Scan GitHub repos for exposed secrets, API keys, and security misconfigurations.' },
  { url: '/free-blacklist-checker/', title: 'Email Blacklist Checker', category: 'Free Tool', description: 'Check if your IP or domain is on major email blacklists (RBL/DNSBL).' },
  { url: '/free-domain-security-score/', title: 'Domain Security Score', category: 'Free Tool', description: 'Get an A-F security grade for any domain based on DNS, SSL, and header analysis.' },
  { url: '/free-dns-checker/', title: 'DNS Record Checker', category: 'Free Tool', description: 'Lookup all DNS records (A, AAAA, MX, TXT, CNAME, NS) for any domain.' },
  { url: '/free-port-scanner/', title: 'Port Scanner', category: 'Free Tool', description: 'Scan common TCP ports on any host to identify open services.' },
  { url: '/free-header-analyzer/', title: 'HTTP Header Analyzer', category: 'Free Tool', description: 'Analyze HTTP response headers for security misconfigurations and missing protections.' },
  { url: '/free-whois-lookup/', title: 'WHOIS Lookup', category: 'Free Tool', description: 'Lookup domain registration data including registrar, dates, and nameservers.' },
  { url: '/free-password-checker/', title: 'Password Breach Checker', category: 'Free Tool', description: 'Check if a password has been exposed in known data breaches (k-anonymity, zero storage).' },
  
  // Paid products
  { url: '/certwatch/', title: 'CertWatch Pro', category: 'Product', description: 'SSL certificate expiry monitoring with daily checks and email alerts. From $1/mo.' },
  { url: '/inbox-shield/', title: 'Inbox Shield', category: 'Product', description: 'Email security gateway with spam filtering, phishing protection, and attachment scanning. $9/mo.' },
  { url: '/compliance/', title: 'Compliance Pro', category: 'Product', description: 'Automated compliance checks for SOC2, HIPAA, PCI-DSS with monthly reports. $9/mo.' },
  
  // Services & plans
  { url: '/services.html', title: 'Managed Security Services', category: 'Services', description: 'SMB cybersecurity monitoring, Wazuh SIEM, monthly action reports. Plans from $199/mo.' },
  { url: '/pricing/', title: 'Pricing', category: 'Page', description: 'All plans and pricing for EdgeIQ Labs products and services.' },
  { url: '/free-tools/', title: 'Free Security Tools', category: 'Page', description: 'Browse all 12+ free cybersecurity scanners and checkers.' },
  { url: '/blog/', title: 'Security Blog & Intel', category: 'Page', description: 'Latest cybersecurity news, breach analysis, vulnerability reports, and SMB guides.' },
  { url: '/docs/', title: 'Documentation', category: 'Page', description: 'API docs, setup guides, and integration references.' },
];

// Scan blog posts
function scanBlogPosts() {
  const blogDir = path.join(ROOT, 'blog');
  const entries = [];
  if (!fs.existsSync(blogDir)) return entries;
  
  const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
  for (const file of files) {
    const content = fs.readFileSync(path.join(blogDir, file), 'utf8');
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const descMatch = content.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    
    const title = h1Match?.[1] || titleMatch?.[1]?.replace(' | EdgeIQ Labs', '') || file.replace('.html', '').replace(/-/g, ' ');
    const description = descMatch?.[1] || '';
    const url = `/blog/${file}`;
    
    entries.push({
      url,
      title: title.trim(),
      category: 'Blog',
      description: description.trim()
    });
  }
  return entries;
}

// Build final index
const blogPosts = scanBlogPosts();
const index = [...PAGES, ...blogPosts].map(entry => ({
  url: entry.url,
  title: entry.title,
  category: entry.category,
  description: entry.description,
  keywords: `${entry.title} ${entry.description} ${entry.category}`.toLowerCase()
}));

fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2));
console.log(`✅ Search index built: ${index.length} entries → ${OUTPUT}`);
console.log(`   Tools: ${index.filter(e => e.category === 'Free Tool').length}`);
console.log(`   Products: ${index.filter(e => e.category === 'Product').length}`);
console.log(`   Blog: ${index.filter(e => e.category === 'Blog').length}`);
console.log(`   Pages: ${index.filter(e => e.category === 'Page' || e.category === 'Services').length}`);
