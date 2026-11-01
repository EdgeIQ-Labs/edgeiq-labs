/* EdgeIQ Labs Theme Controller v1.0 */
(function() {
  'use strict';

  const THEME_KEY = 'edgeiq-theme';
  const DARK = 'dark';
  const LIGHT = 'light';

  function getPreferred() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === DARK || stored === LIGHT) return stored;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? LIGHT : DARK;
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }

  // Apply immediately to prevent flash
  apply(getPreferred());

  // Listen for system preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
    if (!localStorage.getItem(THEME_KEY)) {
      apply(e.matches ? DARK : LIGHT);
    }
  });

  // Expose toggle for UI buttons
  window.toggleTheme = function() {
    var current = document.documentElement.getAttribute('data-theme') || DARK;
    apply(current === DARK ? LIGHT : DARK);
  };

  // Expose getter
  window.getCurrentTheme = function() {
    return document.documentElement.getAttribute('data-theme') || DARK;
  };
})();
