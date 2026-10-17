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
