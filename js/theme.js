/* EdgeIQ Labs Theme Toggle */
(function() {
  'use strict';

  var STORAGE_KEY = 'edgeiq-theme';
  var DARK = 'dark';
  var LIGHT = 'light';

  // Get saved preference or default to dark
  function getTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) || DARK;
    } catch(e) {
      return DARK;
    }
  }

  // Apply theme to document
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Update meta theme-color for mobile browsers
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === LIGHT ? '#f5f7fa' : '#0b0f14');
    }
  }

  // Initialize immediately to prevent FOUC
  var currentTheme = getTheme();
  applyTheme(currentTheme);

  // Toggle handler
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || DARK;
    var next = current === DARK ? LIGHT : DARK;
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch(e) {}
    updateToggleIcon(next);
  }

  // Update toggle button icon
  function updateToggleIcon(theme) {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    // Sun icon for light mode (click to go dark), Moon icon for dark mode (click to go light)
    if (theme === LIGHT) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      btn.setAttribute('aria-label', 'Switch to dark mode');
    } else {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      btn.setAttribute('aria-label', 'Switch to light mode');
    }
  }

  // Expose toggle function globally
  window.toggleTheme = toggleTheme;

  // Wire up when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      updateToggleIcon(currentTheme);
    });
  } else {
    updateToggleIcon(currentTheme);
  }
})();
