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
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    var busy = f.getAttribute('data-busy');
    if (busy) { var b2 = f.querySelector('button'); if (b2) { b2.disabled = true; b2.textContent = busy; } }
    // Un formulaire envoyé ne part qu'une fois (double clic, réseau lent).
    if ((f.method || '').toLowerCase() === 'post') {
      if (f.dataset.sent) { e.preventDefault(); return; }
      f.dataset.sent = '1';
      setTimeout(function () { f.querySelectorAll('button[type=submit],button:not([type])').forEach(function (b) { b.disabled = true; }); }, 0);
      setTimeout(function () { delete f.dataset.sent; f.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); }, 8000);
    }
  });
  // Retour arrière du navigateur : les boutons redeviennent cliquables.
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-sent]').forEach(function (f) { delete f.dataset.sent; f.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); });
  });

  // Filtre instantané d'un tableau (tape, la liste se réduit).
  document.querySelectorAll('[data-filter]').forEach(function (inp) {
    var table = document.querySelector(inp.getAttribute('data-filter'));
    if (!table) return;
    var count = document.querySelector('[data-filter-count]');
    var key = 'flt:' + location.pathname;
    try { var saved = sessionStorage.getItem(key); if (saved) inp.value = saved; } catch (x) {}
    var run = function () {
      var words = inp.value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
      var n = 0;
      table.querySelectorAll('tbody tr[data-q]').forEach(function (tr) {
        var txt = tr.getAttribute('data-q').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        var ok = words.every(function (w) { return txt.indexOf(w) !== -1; });
        tr.hidden = !ok; if (ok) n++;
      });
      if (count) count.textContent = n + ' OF affiché' + (n > 1 ? 's' : '') + (words.length ? ' pour « ' + inp.value + ' »' : '') + '.';
      try { sessionStorage.setItem(key, inp.value); } catch (x) {}
    };
    inp.addEventListener('input', run);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { inp.value = ''; run(); inp.blur(); }
      if (e.key === 'Enter') { e.preventDefault(); var first = table.querySelector('tbody tr[data-q]:not([hidden]) a'); if (first) location.href = first.href; }
    });
    if (inp.value) run();
  });

  // Tri d'un tableau en cliquant sur l'en-tête de colonne.
  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.tabIndex = 0; th.title = 'Trier';
    var sort = function () {
      var table = th.closest('table'), tb = table.tBodies[0];
      var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
      var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
      th.parentNode.querySelectorAll('th').forEach(function (x) { x.removeAttribute('aria-sort'); });
      th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
      var rows = Array.prototype.slice.call(tb.querySelectorAll('tr[data-q]'));
      var val = function (tr) { var c = tr.children[idx]; return c ? (c.getAttribute('data-v') ?? c.textContent) : ''; };
      rows.sort(function (a, b) {
        var x = val(a), y = val(b), nx = parseFloat(x), ny = parseFloat(y);
        if (!isNaN(nx) && !isNaN(ny) && String(nx) === x.trim() && String(ny) === y.trim()) return (nx - ny) * dir;
        return x.localeCompare(y, 'fr', { numeric: true }) * dir;
      });
      rows.forEach(function (r) { tb.appendChild(r); });
    };
    th.addEventListener('click', sort);
    th.addEventListener('keydown', function (e) { if (e.key === 'Enter') sort(); });
  });

  // Sélection de plusieurs OF : la barre d'actions apparaît.
  var lot = document.querySelector('[data-lot]');
  if (lot) {
    var boxes = function () { return document.querySelectorAll('input[name=ids][form=lot]'); };
    var upd = function () {
      var n = 0; boxes().forEach(function (b) { if (b.checked) n++; b.closest('tr').classList.toggle('sel', b.checked); });
      lot.hidden = !n;
      lot.querySelector('[data-lot-count]').textContent = n + ' OF sélectionné' + (n > 1 ? 's' : '');
    };
    document.addEventListener('change', function (e) {
      if (e.target.matches('[data-lot-all]')) boxes().forEach(function (b) { if (!b.closest('tr').hidden) b.checked = e.target.checked; });
      if (e.target.matches('[data-lot-all], input[name=ids]')) upd();
    });
    lot.querySelector('[data-lot-clear]').addEventListener('click', function () { boxes().forEach(function (b) { b.checked = false; }); var a = document.querySelector('[data-lot-all]'); if (a) a.checked = false; upd(); });
    upd();
  }
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
    // « / » : filtrer la liste de la page (ou chercher partout).
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { var fl = document.querySelector('[data-filter]') || document.getElementById('qsearch'); if (fl) { e.preventDefault(); fl.focus(); fl.select && fl.select(); } }
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

// Mode nuit : bouton dans la colonne, choix gardé sur cet appareil.
(function () {
  var root = document.documentElement;
  var label = function () { document.querySelectorAll('[data-theme-label]').forEach(function (s) { s.textContent = root.getAttribute('data-theme') === 'dark' ? 'Mode jour' : 'Mode nuit'; }); };
  label();
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (!b) return;
    var dark = root.getAttribute('data-theme') !== 'dark';
    if (dark) root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (x) {}
    label();
  });
})();

// Expédition : en cochant une pièce, destinataire et adresse se remplissent depuis la fiche client.
document.addEventListener('change', function (e) {
  var el = e.target;
  if (!el.matches || !el.matches('input[data-recipient]') || !el.checked || !el.form) return;
  var f = el.form;
  [['recipient', 'data-recipient'], ['address', 'data-address']].forEach(function (p) {
    var inp = f.querySelector('[name=' + p[0] + ']');
    if (inp && !inp.value) inp.value = el.getAttribute(p[1]) || '';
  });
});

// Étude en cours (IA) : la page se recharge toute seule.
(function () { var el = document.querySelector('[data-reload]'); if (el) setTimeout(function () { location.reload(); }, (Number(el.getAttribute('data-reload')) || 12) * 1000); })();

// Cockpit sur l'ordinateur du patron : le navigateur lit la liste des clients et la transmet à Carchon OS.
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-cockpit-sync]');
  if (!b) return;
  var msg = document.querySelector('[data-cockpit-msg]');
  var say = function (t) { if (msg) msg.textContent = t; };
  b.disabled = true; say('Lecture de Cockpit…');
  fetch(b.getAttribute('data-cockpit-sync'), { headers: { accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('Cockpit a répondu ' + r.status); return r.json(); })
    .then(function (d) { return fetch('/clients/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d), credentials: 'same-origin' }); })
    .then(function (r) { return r.json(); })
    .then(function (d) { say(d.n + ' client(s) repris de Cockpit.'); setTimeout(function () { location.href = b.getAttribute('data-back') || location.href; location.reload(); }, 900); })
    .catch(function (err) { b.disabled = false; say('Cockpit injoignable depuis ce navigateur (' + err.message + '). Vérifie que Cockpit est ouvert sur cet ordinateur, ou importe un export JSON/CSV.'); });
});
