/**
 * EdgeIQ Verified Badge — Premium Embeddable Widget
 * Usage: <script src="https://edgeiqlabs.com/verified-badge.js" data-badge-id="abc123"></script>
 * Renders a premium trust badge with optional company logo.
 */
(function() {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var badgeId = script.getAttribute('data-badge-id');
  if (!badgeId) { console.warn('[EdgeIQ Verified] Missing data-badge-id'); return; }

  var container = document.createElement('div');
  container.id = 'edgeiq-verified-' + badgeId;
  container.style.cssText = 'display:inline-flex;align-items:center;gap:10px;padding:8px 16px;background:#0b0f14;border:1px solid #b47aff;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1;text-decoration:none;color:#9fb0c7;transition:border-color 0.2s,box-shadow 0.2s;cursor:pointer;box-shadow:0 0 12px rgba(180,122,255,0.15);';
  if (script.parentNode) script.parentNode.insertBefore(container, script.nextSibling);
  container.innerHTML = '<span style="color:#9fb0c7;">Loading verification...</span>';

  fetch('https://edgeiqlabs.com/api/verified-badge?id=' + encodeURIComponent(badgeId))
    .then(function(r) { if (!r.ok) throw new Error('Not found'); return r.json(); })
    .then(function(d) {
      if (d.status !== 'active') {
        container.innerHTML = '<span style="color:#ff6b7a;">⚠ Verification Expired</span>';
        container.style.borderColor = '#ff6b7a';
        return;
      }
      var link = document.createElement('a');
      link.href = d.verification_url || 'https://edgeiqlabs.com/badge/';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Verified by EdgeIQ Labs — View Certificate';
      link.style.cssText = 'display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:inherit;';

      var logoHtml = '';
      if (d.logo) {
        logoHtml = '<img src="' + d.logo + '" alt="' + (d.company || 'Company') + ' logo" style="width:24px;height:24px;border-radius:4px;object-fit:contain;" />';
      } else {
        logoHtml = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#b47aff" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
      }

      var companyLabel = d.company ? ' · ' + d.company : '';
      link.innerHTML = logoHtml +
        '<span style="color:#e8eef7;font-weight:700;">✓ EdgeIQ Verified</span>' +
        '<span style="color:#b47aff;font-size:11px;">' + d.domain + companyLabel + '</span>';

      container.innerHTML = '';
      container.appendChild(link);
      container.addEventListener('mouseenter', function() { this.style.boxShadow = '0 0 20px rgba(180,122,255,0.35)'; });
      container.addEventListener('mouseleave', function() { this.style.boxShadow = '0 0 12px rgba(180,122,255,0.15)'; });
    })
    .catch(function() {
      container.innerHTML = '<span style="color:#ff6b7a;">Badge not found</span>';
      container.style.borderColor = '#333';
    });
})();
