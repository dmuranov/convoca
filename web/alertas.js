// "Avísame de nuevas convocatorias como esta" - the email-alert box.
// Each page places an empty <div data-alerta data-section data-filters> (see alertBox() in
// src/seoUtils.js); this fills it in only when alerts are switched on server-side. Filters come
// from the page and show as chips the visitor can remove; they never type one.
(function () {
  var boxes = document.querySelectorAll('[data-alerta]');
  if (!boxes.length || !window.fetch) return;

  var BENEFICIARIO = { Ayuntamiento: 'ayuntamientos', Junta_Vecinal: 'juntas vecinales', Asociacion: 'asociaciones',
    Club_Deportivo: 'clubes deportivos', AMPA: 'AMPAs', Otro: 'otras entidades' };
  var HEAD = {
    subvenciones: 'Avísame de nuevas convocatorias como esta',
    licitaciones: 'Avísame de nuevas licitaciones como esta',
    negocios: 'Avísame de nuevas ayudas para negocios como esta',
  };
  function label(k, v) {
    switch (k) {
      case 'province': return 'Provincia de ' + v;
      case 'category': return String(v).charAt(0).toUpperCase() + String(v).slice(1);
      case 'beneficiario': return 'Para ' + (BENEFICIARIO[v] || v);
      case 'leader': return 'Solo LEADER';
      case 'cpv': return 'Sector CPV ' + v;
      default: return String(v);
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pageFilters(box) {
    var f = {};
    try { f = JSON.parse(box.dataset.filters || '{}') || {}; } catch (e) { f = {}; }
    Object.keys(f).forEach(function (k) { if (f[k] == null || f[k] === '' || f[k] === false) delete f[k]; });
    return f;
  }

  function init(box, consent) {
    var section = box.dataset.section;
    var removed = {};
    box.hidden = false;
    box.innerHTML =
      '<h3>' + esc(HEAD[section] || HEAD.subvenciones) + '</h3>' +
      '<div class="alerta-chips"></div>' +
      '<form class="alerta-form" novalidate>' +
        '<input type="email" name="email" required autocomplete="email" placeholder="tu correo electrónico" aria-label="Tu correo electrónico">' +
        '<select name="frequency" aria-label="Frecuencia"><option value="weekly">Cada lunes</option><option value="daily">Cada día</option></select>' +
        '<input class="alerta-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<button class="btn" type="submit">Avísame</button>' +
      '</form>' +
      '<p class="alerta-msg" role="status"></p>' +
      '<p class="alerta-consent">' + esc(consent) + ' <a href="/privacidad">Privacidad</a>.</p>';
    var chips = box.querySelector('.alerta-chips');
    var formEl = box.querySelector('form');
    var msg = box.querySelector('.alerta-msg');

    function current() {
      var f = pageFilters(box);
      Object.keys(removed).forEach(function (k) { delete f[k]; });
      return f;
    }
    function drawChips() {
      var f = current();
      var keys = Object.keys(f);
      chips.innerHTML = keys.length
        ? keys.map(function (k) {
            return '<span class="alerta-chip">' + esc(label(k, f[k])) +
              ' <button type="button" data-k="' + esc(k) + '" aria-label="Quitar ' + esc(label(k, f[k])) + '">×</button></span>';
          }).join('')
        : '<span class="alerta-chip all">Toda España</span>';
    }
    chips.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-k]');
      if (!b) return;
      removed[b.dataset.k] = true;
      drawChips();
    });
    // Listing pages update data-filters as the visitor filters; start fresh from the new set.
    new MutationObserver(function () { removed = {}; drawChips(); })
      .observe(box, { attributes: true, attributeFilter: ['data-filters'] });
    drawChips();

    formEl.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = formEl.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Revisa el correo: no parece válido.'; return; }
      var btn = formEl.querySelector('button');
      btn.disabled = true;
      msg.textContent = 'Enviando…';
      fetch('/api/alertas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email, section: section, filters: current(), frequency: formEl.frequency.value,
          website: formEl.website.value, consent: true, source_url: location.pathname,
        }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          msg.textContent = res.ok ? res.j.message : (res.j.error || 'No ha funcionado. Prueba de nuevo.');
          if (res.ok) formEl.reset();
        })
        .catch(function () { msg.textContent = 'No ha funcionado. Prueba de nuevo.'; })
        .then(function () { btn.disabled = false; });
    });
  }

  fetch('/api/alertas/estado').then(function (r) { return r.json(); }).then(function (s) {
    if (!s || !s.enabled) return;
    for (var i = 0; i < boxes.length; i++) init(boxes[i], s.consent);
  }).catch(function () { /* alerts unavailable: the box stays hidden */ });
})();
