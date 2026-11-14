/**
 * EdgeIQ Labs Security Badge — Embeddable Widget
 * Usage: <script src="https://edgeiqlabs.com/badge.js" data-badge-id="abc123def456"></script>
 * Renders a dark-themed security grade badge linking back to the full report.
 */
(function() {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var badgeId = script.getAttribute('data-badge-id');
  if (!badgeId) {
    console.warn('[EdgeIQ Badge] Missing data-badge-id attribute');
    return;
  }

  var container = document.createElement('div');
  container.id = 'edgeiq-badge-' + badgeId;
  container.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:6px 14px;background:#0b0f14;border:1px solid #1e2a3a;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1;text-decoration:none;color:#9fb0c7;transition:border-color 0.2s,box-shadow 0.2s;cursor:pointer;';

  // Insert right after the script tag
  if (script.parentNode) {
    script.parentNode.insertBefore(container, script.nextSibling);
  }

  // Loading state
  container.innerHTML = '<span style="color:#9fb0c7;">Loading security grade...</span>';

  fetch('https://edgeiqlabs.com/api/badge?id=' + encodeURIComponent(badgeId))
    .then(function(res) {
      if (!res.ok) throw new Error('Badge not found');
      return res.json();
    })
    .then(function(data) {
      var gradeColor = '#3de19e'; // green default
      if (data.grade === 'F' || data.score < 30) gradeColor = '#ff6b6b';
      else if (data.grade === 'D' || data.score < 50) gradeColor = '#ff8c42';
      else if (data.grade === 'C' || data.score < 70) gradeColor = '#ffd166';
      else if (data.grade === 'B' || data.score < 85) gradeColor = '#3dd9ff';

      var link = document.createElement('a');
      link.href = data.report_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'View full security report by EdgeIQ Labs';
      link.style.cssText = 'display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:inherit;';

      // Shield icon SVG
      var shield = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + gradeColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4" stroke="' + gradeColor + '"/></svg>';

      link.innerHTML = shield +
        '<span style="color:#e8eef7;font-weight:600;">Security Grade:</span>' +
        '<span style="color:' + gradeColor + ';font-weight:800;font-size:14px;">' + data.grade + '</span>' +
        '<span style="color:#9fb0c7;">(' + data.score + '/100)</span>' +
        '<span style="color:#3dd9ff;font-size:11px;margin-left:2px;">Verified by EdgeIQ Labs</span>';

      container.innerHTML = '';
      container.appendChild(link);

      // Hover effect
      container.onmouseenter = function() {
        container.style.borderColor = gradeColor;
        container.style.boxShadow = '0 0 12px ' + gradeColor + '33';
      };
      container.onmouseleave = function() {
        container.style.borderColor = '#1e2a3a';
        container.style.boxShadow = 'none';
      };
    })
    .catch(function(err) {
      container.innerHTML = '<span style="color:#ff6b6b;">Badge unavailable</span>';
      container.title = err.message;
    });
})();
