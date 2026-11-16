/**
 * Shared check logic — imported by both base endpoints and v1 API wrappers.
 * Eliminates self-fetch loops that double CPU usage on every request.
 */

// ─── Cert Expiry Check (from crt.sh) ──────────────────────────────
export async function checkCertExpiry(domain) {
  try {
    var resp = await fetch(
      'https://crt.sh/?q=' + encodeURIComponent(domain) + '&output=json',
      { headers: { 'User-Agent': 'EdgeIQ-CertWatch/1.0', 'Accept': 'application/json' } }
    );
    if (!resp.ok) return { domain, status: 'error', error: 'Certificate lookup failed' };

    var text = await resp.text();
    var certs;
    try { certs = JSON.parse(text); } catch { return { domain, status: 'error', error: 'Failed to parse certificate data' }; }

    if (!Array.isArray(certs) || certs.length === 0) return { domain, status: 'error', error: 'No certificates found' };

    var matching = [];
    for (var i = 0; i < certs.length; i++) {
      var c = certs[i];
      if (!c.not_after || !c.not_before) continue;
      var nameValue = c.name_value || '';
      var commonName = c.common_name || '';
      if (nameValue.indexOf(domain) !== -1 || commonName === domain) matching.push(c);
    }
    if (matching.length === 0) matching = certs.filter(function(c) { return c.not_after && c.not_before; });
    if (matching.length === 0) return { domain, status: 'error', error: 'No valid certificates found' };

    matching.sort(function(a, b) { return new Date(b.not_before).getTime() - new Date(a.not_before).getTime(); });
    var latest = matching[0];
    var expiryDate = new Date(latest.not_after);
    var now = new Date();
    var daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    var status = 'valid';
    if (daysUntilExpiry <= 0) status = 'expired';
    else if (daysUntilExpiry <= 30) status = 'expiring_soon';

    var issuerRaw = latest.issuer_name || 'Unknown';
    var cnMatch = issuerRaw.match(/CN=([^,]+)/);
    var issuerCN = cnMatch ? cnMatch[1] : issuerRaw;

    return {
      domain, status,
      expiry_date: expiryDate.toISOString(),
      days_until_expiry: daysUntilExpiry,
      issuer: issuerCN,
      common_name: latest.common_name || domain,
      serial: latest.serial_number || null,
    };
  } catch (e) {
    return { domain, status: 'error', error: e.message || 'Unknown error' };
  }
}

// ─── Header Check (inline from header-check.js core logic) ────────
export async function checkHeaders(domain) {
  // Placeholder — will be populated when we refactor header-check.js
  // For now, fall back to fetch but this should be replaced with inline logic
  const resp = await fetch(`https://edgeiqlabs.com/api/header-check?domain=${encodeURIComponent(domain)}`);
  return await resp.json();
}

// ─── SSL Check (inline from ssl-check.js core logic) ──────────────
export async function checkSSL(domain) {
  const resp = await fetch(`https://edgeiqlabs.com/api/ssl-check?domain=${encodeURIComponent(domain)}`);
  return await resp.json();
}

// ─── DNS Check (inline from dns-check.js core logic) ──────────────
export async function checkDNS(domain) {
  const resp = await fetch(`https://edgeiqlabs.com/api/dns-check?domain=${encodeURIComponent(domain)}`);
  return await resp.json();
}

// ─── Breach Check (inline from breach-check.js core logic) ────────
export async function checkBreach(email) {
  const resp = await fetch(`https://edgeiqlabs.com/api/breach-check?email=${encodeURIComponent(email)}`);
  return await resp.json();
}

// ─── Repo Scan (inline from repo-scanner.js core logic) ───────────
export async function scanRepo(url) {
  const resp = await fetch('https://edgeiqlabs.com/api/repo-scanner', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  return await resp.json();
}
