// Petits comportements côté navigateur. Tout fonctionne aussi sans JavaScript (formulaires classiques).
(function () {
  // --- La page reste à sa place après un clic, un enregistrement ou un filtre ---
  // Avant de partir, on note la position ; si on revient sur la même page, on la remet exactement.
  var KEY = 'carchon:pos';
  function remember() {
    try { sessionStorage.setItem(KEY, JSON.stringify({ p: location.pathname, y: window.scrollY, t: Date.now() })); } catch (x) {}
  }
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    sessionStorage.removeItem(KEY);
    if (saved && saved.p === location.pathname && Date.now() - saved.t < 20000) {
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      document.documentElement.classList.add('kept');
      var put = function () { window.scrollTo(0, saved.y); };
      put(); requestAnimationFrame(put);
      window.addEventListener('load', function () { put(); setTimeout(put, 0); });
      // L'ancre (#bloc) de l'adresse ne doit pas faire sauter la page.
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (x) {}
  var nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { remember(); return nativeSubmit.call(this); };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || a.hasAttribute('download')) return;
    var u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname === location.pathname && (u.search !== location.search)) remember();
  });

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
  // Ligne de tableau cliquable (sauf sur ses boutons et liens).
  document.addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr[data-href]');
    if (!tr || e.target.closest('a, button, input, select, textarea, summary, details, form, label')) return;
    location.href = tr.getAttribute('data-href');
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
    if (e.target.closest && e.target.closest('[data-back]') && history.length > 1) { e.preventDefault(); history.back(); }
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

  // Fiche projet : onglets (sans JavaScript, toutes les sections restent affichées les unes sous les autres).
  var tabs = document.querySelector('[data-ptabs]');
  if (tabs) {
    var panels = Array.prototype.slice.call(document.querySelectorAll('.ptab'));
    var key = 'ptab:' + location.pathname;
    var show = function (id, scrollTo) {
      var panel = panels.filter(function (x) { return x.id === id; })[0];
      if (!panel) { var el = id && document.getElementById(id); panel = el && el.closest && el.closest('.ptab'); }
      if (!panel) return false;
      panels.forEach(function (x) { x.classList.toggle('on', x === panel); });
      tabs.querySelectorAll('a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + panel.id); });
      try { sessionStorage.setItem(key, panel.id); } catch (x) {}
      var target = scrollTo && document.getElementById(scrollTo);
      if (target && target !== panel) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView({ block: 'start' }); }
      return true;
    };
    document.body.classList.add('js-tabs');
    var h0 = location.hash.slice(1) || (new URLSearchParams(location.search).get('tab') || ''), saved = null;
    try { saved = sessionStorage.getItem(key); } catch (x) {}
    if (!(h0 && show(h0, h0)) && !(saved && show(saved))) show(panels[0].id);
    window.addEventListener('hashchange', function () { var id = location.hash.slice(1); if (id) show(id, id); });
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute('href').slice(1);
      if (id && show(id, a.closest('[data-ptabs]') ? null : id)) {
        e.preventDefault();
        history.replaceState(null, '', '#' + id);
        // Clic sur un onglet : la page ne bouge pas. Lien vers un onglet depuis plus bas : on remonte seulement si la barre est hors de l'écran.
        if (!a.closest('[data-ptabs]') && a.hasAttribute('data-tab-link') && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: 'start' });
      }
    });
  }

  // Dictée vocale (Safari iPad, Chrome) : le texte s'ajoute dans la zone de saisie.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('[data-dictee]').forEach(function (btn) {
    if (!SR) return;
    var ta = document.querySelector(btn.getAttribute('data-dictee'));
    if (!ta) return;
    btn.hidden = false;
    var rec = null, base = '';
    btn.addEventListener('click', function () {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = true;
      base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
      rec.onresult = function (ev) {
        var fin = '', tmp = '';
        for (var i = 0; i < ev.results.length; i++) { var t = ev.results[i][0].transcript; if (ev.results[i].isFinal) fin += t; else tmp += t; }
        ta.value = base + fin + tmp;
      };
      rec.onend = function () { rec = null; btn.classList.remove('rec'); btn.textContent = '● Dicter'; };
      rec.onerror = function () { if (rec) rec.stop(); };
      rec.start(); btn.classList.add('rec'); btn.textContent = '■ Arrêter la dictée';
    });
  });

  // CNC : curseur d'avancement du programme (les opérations s'affichent dans l'ordre d'usinage).
  document.querySelectorAll('[data-cnc-slider]').forEach(function (inp) {
    var svg = document.querySelector(inp.getAttribute('data-cnc-slider'));
    if (!svg) return;
    var ops = svg.querySelectorAll('.cnc-op');
    inp.addEventListener('input', function () { var n = Number(inp.value); ops.forEach(function (g, i) { g.classList.toggle('off', i >= n); }); });
  });

  // Envoi d'un formulaire (après les confirmations) : on garde la position.
  document.addEventListener('submit', function (e) { if (!e.defaultPrevented) remember(); });
  // Message de confirmation : affiché en bas de l'écran, sans déplacer la page.
  document.querySelectorAll('.flash.toast').forEach(function (t) {
    t.addEventListener('click', function () { t.remove(); });
    if (!t.classList.contains('ko') && !t.querySelector('code, a, input')) setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 400); }, 6000);
  });
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
