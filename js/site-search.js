/**
 * EdgeIQ Labs Site Search — lightweight client-side search overlay
 * No dependencies. Loads search-index.json and provides fuzzy matching.
 */
(function() {
  'use strict';

  let searchIndex = null;
  let isOpen = false;

  // Create overlay DOM
  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'site-search-overlay';
    overlay.className = 'search-overlay hidden';
    overlay.innerHTML = `
      <div class="search-backdrop" data-search-close></div>
      <div class="search-modal" role="dialog" aria-label="Site search">
        <div class="search-input-wrap">
          <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="search-input" placeholder="Search tools, services, blog..." autocomplete="off" spellcheck="false" />
          <kbd class="search-esc">ESC</kbd>
        </div>
        <div id="search-results" class="search-results"></div>
        <div class="search-footer"><span>Type to search · <kbd>/</kbd> or <kbd>Ctrl+K</kbd> to open</span></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Event listeners
    overlay.querySelector('[data-search-close]').addEventListener('click', closeSearch);
    overlay.querySelector('#search-input').addEventListener('input', debounce(handleSearch, 150));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSearch();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') navigateResults(e);
      if (e.key === 'Enter') selectResult(e);
    });
  }

  // Load index
  async function loadIndex() {
    if (searchIndex) return;
    try {
      const resp = await fetch('/search-index.json');
      searchIndex = await resp.json();
    } catch (err) {
      console.error('Failed to load search index:', err);
      searchIndex = [];
    }
  }

  // Open search
  function openSearch() {
    if (isOpen) return;
    loadIndex().then(() => {
      const overlay = document.getElementById('site-search-overlay');
      overlay.classList.remove('hidden');
      overlay.classList.add('active');
      document.getElementById('search-input').value = '';
      document.getElementById('search-results').innerHTML = '<div class="search-empty">Start typing to search...</div>';
      setTimeout(() => document.getElementById('search-input').focus(), 50);
      isOpen = true;
      document.body.style.overflow = 'hidden';
    });
  }

  // Close search
  function closeSearch() {
    if (!isOpen) return;
    const overlay = document.getElementById('site-search-overlay');
    overlay.classList.remove('active');
    overlay.classList.add('hidden');
    isOpen = false;
    document.body.style.overflow = '';
  }

  // Fuzzy match scoring
  function scoreMatch(query, entry) {
    const q = query.toLowerCase();
    const title = entry.title.toLowerCase();
    const desc = entry.description.toLowerCase();
    const cat = entry.category.toLowerCase();
    const keywords = entry.keywords || '';

    let score = 0;
    if (title === q) score += 100;
    else if (title.startsWith(q)) score += 80;
    else if (title.includes(q)) score += 60;
    if (cat.includes(q)) score += 30;
    if (desc.includes(q)) score += 20;
    if (keywords.includes(q)) score += 10;
    // Bonus for word boundary matches
    if (new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(title)) score += 15;
    return score;
  }

  // Handle search input
  function handleSearch(e) {
    const query = e.target.value.trim();
    const resultsEl = document.getElementById('search-results');

    if (!query) {
      resultsEl.innerHTML = '<div class="search-empty">Start typing to search...</div>';
      return;
    }

    if (!searchIndex || searchIndex.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">Search index loading...</div>';
      return;
    }

    const scored = searchIndex
      .map(entry => ({ ...entry, score: scoreMatch(query, entry) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    if (scored.length === 0) {
      resultsEl.innerHTML = `<div class="search-empty">No results for "${escapeHtml(query)}"</div>`;
      return;
    }

    resultsEl.innerHTML = scored.map((item, i) => `
      <a href="${item.url}" class="search-result-item${i === 0 ? ' selected' : ''}" data-index="${i}">
        <span class="search-result-badge" data-cat="${item.category}">${item.category}</span>
        <span class="search-result-title">${highlightMatch(item.title, query)}</span>
        <span class="search-result-desc">${highlightMatch(truncate(item.description, 80), query)}</span>
      </a>
    `).join('');
  }

  // Keyboard navigation
  function navigateResults(e) {
    const items = document.querySelectorAll('.search-result-item');
    if (items.length === 0) return;
    const current = document.querySelector('.search-result-item.selected');
    let idx = current ? parseInt(current.dataset.index) : -1;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(idx + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(idx - 1, 0);
    }

    items.forEach(el => el.classList.remove('selected'));
    items[idx]?.classList.add('selected');
    items[idx]?.scrollIntoView({ block: 'nearest' });
  }

  function selectResult(e) {
    const selected = document.querySelector('.search-result-item.selected');
    if (selected) {
      e.preventDefault();
      window.location.href = selected.getAttribute('href');
    }
  }

  // Utilities
  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  // Global keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !isOpen) {
      // Don't hijack if user is typing in another input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      openSearch();
    }
  });

  // Expose open function for nav button
  window.openSiteSearch = openSearch;

  // Init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createOverlay);
  } else {
    createOverlay();
  }
})();
