// Petits comportements côté navigateur. Tout fonctionne aussi sans JavaScript (formulaires classiques).
(function () {
  // Case à cocher / date qui enregistre tout de suite.
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.matches && el.matches('[data-auto]') && el.form) el.form.submit();
  });
  // Confirmation avant une action importante.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirm');
    var btn = e.submitter;
    if (btn && btn.getAttribute('data-confirm-btn')) msg = btn.getAttribute('data-confirm-btn');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  // Copier un lien.
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (b) {
      var input = document.querySelector(b.getAttribute('data-copy'));
      input.select();
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.resolve(document.execCommand('copy'))).then(function () { b.textContent = 'Copié ✓'; });
    }
    if (e.target.closest && e.target.closest('[data-print]')) window.print();
  });
  // Un seul menu ouvert à la fois ; clic à l'extérieur = fermer.
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.menu[open], details.fz[open], details.pbar[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  // Raccourci ⌘K / Ctrl+K pour la recherche.
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { var s = document.getElementById('qsearch'); if (s) { e.preventDefault(); s.focus(); } }
  });
  // Signature du PV au doigt.
  var c = document.getElementById('sig');
  if (c) {
    var ctx = c.getContext('2d'), drawing = false, drawn = false;
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#1C1917';
    var pos = function (ev) { var r = c.getBoundingClientRect(); return [(ev.clientX - r.left) * c.width / r.width, (ev.clientY - r.top) * c.height / r.height]; };
    c.addEventListener('pointerdown', function (ev) { drawing = true; drawn = true; var p = pos(ev); ctx.beginPath(); ctx.moveTo(p[0], p[1]); c.setPointerCapture(ev.pointerId); });
    c.addEventListener('pointermove', function (ev) { if (!drawing) return; var p = pos(ev); ctx.lineTo(p[0], p[1]); ctx.stroke(); });
    c.addEventListener('pointerup', function () { drawing = false; });
    document.getElementById('sigclear').addEventListener('click', function () { ctx.clearRect(0, 0, c.width, c.height); drawn = false; });
    document.getElementById('pvform').addEventListener('submit', function (e) {
      if (!drawn) { e.preventDefault(); alert('La signature du client est nécessaire.'); return; }
      document.getElementById('sigdata').value = c.toDataURL('image/png');
    });
  }
})();
