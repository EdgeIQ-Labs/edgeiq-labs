/**
 * EdgeIQ Labs — Animated Grade Ring
 * Replaces static .grade-circle divs with SVG stroke-draw animation.
 * Requires design-system.css (grade-ring-* classes).
 */
function renderGradeRing(container, grade, score) {
  var circumference = 251.33; // 2 * PI * r(40)
  var pct = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : 0;
  var offset = circumference - (pct / 100) * circumference;
  var letter = (grade || 'F').charAt(0).toUpperCase();

  container.innerHTML =
    '<div class="grade-ring-wrap grade-' + letter + '" id="gradeRing">' +
      '<svg class="grade-ring-svg" viewBox="0 0 90 90">' +
        '<circle class="grade-ring-bg" cx="45" cy="45" r="40"/>' +
        '<circle class="grade-ring-fg" cx="45" cy="45" r="40" ' +
          'style="stroke-dashoffset:' + circumference + '"/>' +
      '</svg>' +
      '<span class="grade-ring-letter">' + letter + '</span>' +
      (typeof score === 'number' ? '<span class="grade-ring-score">' + pct + '%</span>' : '') +
    '</div>';

  // Trigger draw animation after paint
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      var wrap = document.getElementById('gradeRing');
      if (!wrap) return;
      var fg = wrap.querySelector('.grade-ring-fg');
      if (fg) fg.style.strokeDashoffset = offset;
      wrap.classList.add('animated');
    });
  });
  // Fallback for environments where rAF double-buffer doesn't fire
  setTimeout(function() {
    var wrap = document.getElementById('gradeRing');
    if (!wrap || wrap.classList.contains('animated')) return;
    var fg = wrap.querySelector('.grade-ring-fg');
    if (fg) fg.style.strokeDashoffset = offset;
    wrap.classList.add('animated');
  }, 50);
}
