/**
 * EdgeIQ Labs — Theme Toggle
 * Dark-first. Respects prefers-color-scheme on first visit,
 * then user choice wins via localStorage.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'edgeiq-theme';
  const DARK = 'dark';
  const LIGHT = 'light';

  // Determine initial theme before paint
  function getInitialTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === DARK || stored === LIGHT) return stored;
    // Respect OS preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return LIGHT;
    }
    return DARK; // default
  }

  // Apply theme to document
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update meta theme-color for mobile browsers
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === DARK ? '#0A1628' : '#F7F8FA');
    }
    // Update toggle icon
    updateToggleIcon(theme);
  }

  // Update the toggle button icon
  function updateToggleIcon(theme) {
    const btn = document.querySelector('.theme-toggle');
    if (!btn) return;
    // Sun for light mode, moon for dark mode
    btn.textContent = theme === DARK ? '☀' : '☾';
    btn.setAttribute('aria-label', theme === DARK ? 'Switch to light mode' : 'Switch to dark mode');
  }

  // Toggle handler
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || DARK;
    const next = current === DARK ? LIGHT : DARK;
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  // Initialize immediately (before DOMContentLoaded to prevent flash)
  const initialTheme = getInitialTheme();
  applyTheme(initialTheme);

  // Bind toggle after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindToggle);
  } else {
    bindToggle();
  }

  function bindToggle() {
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      btn.addEventListener('click', toggleTheme);
      updateToggleIcon(initialTheme);
    }

    // Listen for OS theme changes
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        // Only auto-switch if user hasn't set a preference
        if (!localStorage.getItem(STORAGE_KEY)) {
          applyTheme(e.matches ? DARK : LIGHT);
        }
      });
    }
  }
})();

// ── Animated Hero Terminal ──────────────────────────────────────────────────
(function() {
  var lines = [
    { delay: 0,    text: '> scanning edgeiqlabs.com...' },
    { delay: 600,  text: 'SSL Certificate    <span class="ok">✅ Valid — A+</span>' },
    { delay: 1100, text: 'TLS Version        <span class="ok">✅ TLS 1.3</span>' },
    { delay: 1600, text: 'Security Headers   <span class="warn">⚠ 7/8 — X-Frame missing</span>' },
    { delay: 2100, text: 'XSS Posture        <span class="ok">✅ No reflected params</span>' },
    { delay: 2600, text: 'Subdomain Enum     <span class="ok">✅ 12 exposed subdomains</span>' },
    { delay: 3000, text: 'Threats Detected   <span class="ok">✅ 0 critical</span>' },
  ];

  var el = document.getElementById('terminal-line-1');
  if (!el) return;

  var output = document.createElement('span');
  el.appendChild(output);

  var html = '';
  var charIdx = 0;
  var lineIdx = 0;

  function typeNextChar() {
    if (lineIdx >= lines.length) return;
    var line = lines[lineIdx];
    if (charIdx < line.text.length) {
      var remaining = line.text.substring(charIdx);
      var tagMatch = remaining.match(/^<[^>]+>/);
      if (tagMatch) {
        html += tagMatch[0];
        charIdx += tagMatch[0].length;
      } else {
        html += line.text[charIdx];
        charIdx++;
      }
      output.innerHTML = html;
      setTimeout(typeNextChar, 18);
    } else {
      lineIdx++;
      charIdx = 0;
      if (lineIdx < lines.length) {
        html += '<br>';
        output.innerHTML = html;
        setTimeout(typeNextChar, lines[lineIdx].delay - line.delay - line.text.length * 18);
      }
    }
  }

  setTimeout(typeNextChar, 400);

  // ── Live scan counter ───────────────────────────────────────────────────
  var counter = document.getElementById('live-counter');
  if (counter) {
    var base = 143073;
    setInterval(function() {
      base += Math.floor(Math.random() * 3) + 1;
      counter.textContent = base.toLocaleString();
    }, 4000);
  }
})();

// Re-run terminal animation on DOMContentLoaded if it missed the elements
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    var el = document.getElementById('terminal-line-1');
    if (el && !el.querySelector('span')) {
      // Trigger the IIFE logic again by re-firing
      var lines = [
        { delay: 0,    text: '> scanning edgeiqlabs.com...' },
        { delay: 600,  text: 'SSL Certificate    <span class="ok">✅ Valid — A+</span>' },
        { delay: 1100, text: 'TLS Version        <span class="ok">✅ TLS 1.3</span>' },
        { delay: 1600, text: 'Security Headers   <span class="warn">⚠ 7/8 — X-Frame missing</span>' },
        { delay: 2100, text: 'XSS Posture        <span class="ok">✅ No reflected params</span>' },
        { delay: 2600, text: 'Subdomain Enum     <span class="ok">✅ 12 exposed subdomains</span>' },
        { delay: 3000, text: 'Threats Detected   <span class="ok">✅ 0 critical</span>' },
      ];
      var output = document.createElement('span');
      el.appendChild(output);
      var html = '', charIdx = 0, lineIdx = 0;
      function typeNextChar() {
        if (lineIdx >= lines.length) return;
        var line = lines[lineIdx];
        if (charIdx < line.text.length) {
          var remaining = line.text.substring(charIdx);
          var tagMatch = remaining.match(/^<[^>]+>/);
          if (tagMatch) { html += tagMatch[0]; charIdx += tagMatch[0].length; }
          else { html += line.text[charIdx]; charIdx++; }
          output.innerHTML = html;
          setTimeout(typeNextChar, 18);
        } else {
          lineIdx++; charIdx = 0;
          if (lineIdx < lines.length) {
            html += '<br>'; output.innerHTML = html;
            setTimeout(typeNextChar, lines[lineIdx].delay - line.delay - line.text.length * 18);
          }
        }
      }
      setTimeout(typeNextChar, 400);
    }
  });
}
