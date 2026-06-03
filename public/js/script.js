/* ============================================================
   Bistrout & Café Mozart — Script frontend
   - Lingua (9 lingue), navbar, menu mobile, animazioni
   - Menu del Giorno (nome + descrizione + prezzo + esaurito)
   - Prenotazione: solo oggi, orari localizzati con disponibilità
     per fascia oraria, pietanze FACOLTATIVE (una o più), GDPR
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const t = (k) => window.I18N.t(k);

  /* ---------- Anno nel footer ---------- */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- Selettore lingua ---------- */
  const langSelect = document.getElementById('langSelect');
  if (langSelect && window.LINGUE) {
    window.LINGUE.forEach(({ code, label }) => {
      const opt = document.createElement('option');
      opt.value = code; opt.textContent = label;
      langSelect.appendChild(opt);
    });
    langSelect.value = window.I18N.init();
    langSelect.addEventListener('change', () => window.I18N.apply(langSelect.value));
  }

  /* ---------- Navbar allo scroll ---------- */
  const navbar = document.getElementById('navbar');
  const onScroll = () => navbar.classList.toggle('scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll); onScroll();

  /* ---------- Menu mobile ---------- */
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  const toggleMenu = (open) => { hamburger.classList.toggle('open', open); navLinks.classList.toggle('open', open); };
  hamburger.addEventListener('click', () => toggleMenu(!navLinks.classList.contains('open')));
  navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggleMenu(false)));

  /* ---------- Reveal allo scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) { setTimeout(() => entry.target.classList.add('visible'), i * 60); io.unobserve(entry.target); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* ============================================================
     STATO / DATI
     ========================================================== */
  let CONFIG = { slot: [], oggi: '' };
  let DISHES_GIORNO = [];   // [{nome, descrizione}]

  const form = document.getElementById('formPrenota');
  const formMsg = document.getElementById('formMsg');
  const selectOrario = document.getElementById('selectOrario');
  const guestDishes = document.getElementById('guestDishes');
  const dishesHint = document.getElementById('dishesHint');
  const dataInput = form.querySelector('input[name="data"]');
  const personeInput = form.querySelector('input[name="persone"]');
  const gridPiatti = document.getElementById('grid-piatti');

  /* ============================================================
     CARICAMENTO DATI
     ========================================================== */
  fetch('/api/config').then(r => r.json()).then(cfg => {
    CONFIG = cfg; buildOrario(); setupData(); caricaDisponibilita();
  }).catch(() => {});

  gridPiatti.innerHTML = `<p class="piatti-loading">${t('dishes_loading')}</p>`;
  fetch('/api/piatti').then(r => r.json()).then(({ piatti }) => {
    DISHES_GIORNO = piatti || [];
    renderGridPiatti(); buildGuestDishes();
  }).catch(() => { gridPiatti.innerHTML = `<p class="piatti-empty">${t('dishes_error')}</p>`; });

  /* ============================================================
     MENU PDF — visualizzazione INLINE (no download)
     ========================================================== */
  const menuArea = document.getElementById('menuArea');
  const pdfModal = document.getElementById('pdfModal');
  const pdfFrame = document.getElementById('pdfFrame');
  const pdfClose = document.getElementById('pdfClose');

  function aprePdf() {
    // Parametri PDF: nasconde la toolbar (incluso il tasto download nei viewer
    // che lo rispettano). Il contenuto resta visibile, navigabile e zoomabile.
    pdfFrame.src = '/menu.pdf#toolbar=0&navpanes=0&view=FitH';
    pdfModal.classList.add('open');
    pdfModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function chiudePdf() {
    pdfModal.classList.remove('open');
    pdfModal.setAttribute('aria-hidden', 'true');
    pdfFrame.src = '';
    document.body.style.overflow = '';
  }
  if (pdfClose) pdfClose.addEventListener('click', chiudePdf);
  if (pdfModal) pdfModal.addEventListener('click', (e) => { if (e.target === pdfModal) chiudePdf(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudePdf(); });

  function renderMenu(disponibile) {
    if (!menuArea) return;
    if (disponibile) {
      menuArea.innerHTML = `<button type="button" class="btn btn-gold" id="btnMenuView">${t('menu_view')}</button>`;
      document.getElementById('btnMenuView').addEventListener('click', aprePdf);
    } else {
      menuArea.innerHTML = `<p class="menu-unavailable">${t('menu_unavailable')}</p>`;
    }
  }
  fetch('/api/menu').then(r => r.json()).then(({ disponibile }) => renderMenu(disponibile)).catch(() => renderMenu(false));

  /* ============================================================
     COOKIE BANNER + INFORMATIVA PRIVACY (GDPR)
     ========================================================== */
  const COOKIE_KEY = 'mozartCookieOk';
  const cookieBanner = document.getElementById('cookieBanner');
  const privacyModal = document.getElementById('privacyModal');

  function mostraBanner() {
    try {
      if (cookieBanner && !localStorage.getItem(COOKIE_KEY)) cookieBanner.classList.add('show');
    } catch (e) { /* localStorage non disponibile */ }
  }
  function accettaBanner() {
    try { localStorage.setItem(COOKIE_KEY, '1'); } catch (e) {}
    if (cookieBanner) cookieBanner.classList.remove('show');
  }
  function apriPrivacy() {
    if (!privacyModal) return;
    privacyModal.classList.add('open');
    privacyModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
  function chiudiPrivacy() {
    if (!privacyModal) return;
    privacyModal.classList.remove('open');
    privacyModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  // Apertura modale da link multipli (cookie banner, footer, checkbox del form)
  document.addEventListener('click', (e) => {
    const target = e.target.closest('#openPrivacy, #openPrivacyFromCookie, #openPrivacyFromFooter');
    if (target) { e.preventDefault(); apriPrivacy(); }
  });

  const cookieOkBtn = document.getElementById('cookieOk');
  if (cookieOkBtn) cookieOkBtn.addEventListener('click', accettaBanner);
  const privacyCloseBtn = document.getElementById('privacyClose');
  if (privacyCloseBtn) privacyCloseBtn.addEventListener('click', chiudiPrivacy);
  const privacyAcceptBtn = document.getElementById('privacyAccept');
  if (privacyAcceptBtn) privacyAcceptBtn.addEventListener('click', chiudiPrivacy);
  if (privacyModal) privacyModal.addEventListener('click', (e) => { if (e.target === privacyModal) chiudiPrivacy(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudiPrivacy(); });

  // Mostra il banner al primo caricamento (se non già accettato)
  mostraBanner();

  /* ============================================================
     ORARIO (slot localizzati 24h / AM-PM)
     ========================================================== */
  function buildOrario() {
    const prev = selectOrario.value;
    selectOrario.innerHTML = `<option value="">—</option>`;
    (CONFIG.slot || []).forEach(hhmm => {
      const opt = document.createElement('option');
      opt.value = hhmm;
      const liberi = liberiPerOrario(hhmm);
      let etichetta = window.I18N.formatTime(hhmm);
      if (liberi !== null) {
        if (liberi <= 0) { etichetta += ` — ${t('slot_full')}`; opt.disabled = true; }
        else if (liberi <= 5) { etichetta += ` — ${t('slot_few').replace('{n}', liberi)}`; }
        else { etichetta += ` — ${t('slot_avail')}`; }
      }
      opt.textContent = etichetta;
      selectOrario.appendChild(opt);
    });
    if (prev) selectOrario.value = prev;
  }

  /* ============================================================
     DATA (solo oggi, campo bloccato)
     ========================================================== */
  function setupData() {
    if (!dataInput || !CONFIG.oggi) return;
    dataInput.min = CONFIG.oggi;
    dataInput.max = CONFIG.oggi;
    dataInput.value = CONFIG.oggi;
    dataInput.readOnly = true;
  }

  /* ============================================================
     MENU DEL GIORNO (sezione vetrina, con prezzo e disponibilità)
     ========================================================== */
  function renderGridPiatti() {
    gridPiatti.innerHTML = '';
    if (!DISHES_GIORNO.length) {
      gridPiatti.innerHTML = `<p class="piatti-empty">${t('dishes_empty')}</p>`;
      return;
    }
    DISHES_GIORNO.forEach((d, i) => {
      const esaurito = d.stato === 'esaurito';
      const prezzo = (d.prezzo !== null && d.prezzo !== undefined && d.prezzo !== '')
        ? `<span class="piatto-prezzo">€ ${Number(d.prezzo).toFixed(2).replace('.', ',')}</span>` : '';
      const card = document.createElement('article');
      card.className = 'card-piatto reveal visible' + (esaurito ? ' esaurito' : '');
      card.innerHTML = `
        <span class="num">0${i + 1}</span>
        ${esaurito ? `<span class="badge-esaurito">${t('dish_sold_out')}</span>` : ''}
        <h3>${esc(d.nome)}</h3>
        ${d.descrizione ? `<p class="piatto-desc">${esc(d.descrizione)}</p>` : ''}
        ${prezzo}`;
      gridPiatti.appendChild(card);
    });
  }

  /* ============================================================
     SELEZIONE PIETANZE (FACOLTATIVA, una o più)
     L'utente può non scegliere nulla, oppure aggiungere quante
     righe vuole con il pulsante "+ Aggiungi un'altra pietanza".
     Ogni riga può essere rimossa.
     ========================================================== */
  function opzioniPiatti(selectedVal) {
    let html = `<option value="">${t('choose_dish')}</option>`;
    if (DISHES_GIORNO.length) {
      html += `<optgroup label="${t('cat_giorno')}">`;
      DISHES_GIORNO.forEach((d, i) => {
        // I piatti esauriti restano selezionabili ma segnalati
        const val = `giorno|${i}`;
        const suffix = d.stato === 'esaurito' ? ` (${t('dish_sold_out')})` : '';
        html += `<option value="${val}" ${val === selectedVal ? 'selected' : ''}>${esc(d.nome)}${suffix}</option>`;
      });
      html += `</optgroup>`;
    }
    // Nota: l'opzione generica "Drink List" è stata rimossa. La scelta è
    // limitata a "nessuna pietanza" oppure ai piatti del Menu del Giorno.
    return html;
  }

  function risolviPiatto(val) {
    if (!val) return null;
    if (val === 'carta') return { tipo: 'carta', nome: t('cat_carta'), descrizione: '' };
    const [, idx] = val.split('|');
    const d = DISHES_GIORNO[Number(idx)];
    return d ? { tipo: 'giorno', nome: d.nome, descrizione: d.descrizione || '' } : null;
  }

  /** Crea una riga di selezione pietanza. */
  function creaRigaPiatto(valore = '') {
    const row = document.createElement('div');
    row.className = 'guest-row';
    row.innerHTML = `
      <label>
        <select>${opzioniPiatti(valore)}</select>
      </label>
      <button type="button" class="dish-remove" title="${t('dish_remove')}" aria-label="${t('dish_remove')}">×</button>
      <p class="dish-desc"></p>`;
    const sel = row.querySelector('select');
    const desc = row.querySelector('.dish-desc');
    const aggiorna = () => {
      const d = risolviPiatto(sel.value);
      desc.textContent = d && d.descrizione ? d.descrizione : '';
    };
    sel.addEventListener('change', aggiorna);
    aggiorna();
    row.querySelector('.dish-remove').addEventListener('click', () => {
      row.remove();
      // Se non resta nessuna riga, ne creiamo una vuota per comodità
      if (guestDishes && guestDishes.children.length === 0) guestDishes.appendChild(creaRigaPiatto());
    });
    return row;
  }

  function buildGuestDishes() {
    if (!guestDishes) return;
    // Conserva le scelte attuali
    const prev = [...guestDishes.querySelectorAll('select')].map(s => s.value);
    guestDishes.innerHTML = '';
    if (prev.length) {
      prev.forEach(v => guestDishes.appendChild(creaRigaPiatto(v)));
    } else {
      guestDishes.appendChild(creaRigaPiatto());
    }
    if (dishesHint) {
      dishesHint.textContent = t('dishes_hint_one');
      dishesHint.setAttribute('data-i18n', 'dishes_hint_one');
    }
  }

  // Pulsante "Aggiungi un'altra pietanza"
  const btnAddDish = document.getElementById('btnAddDish');
  if (btnAddDish) btnAddDish.addEventListener('click', () => {
    if (guestDishes) guestDishes.appendChild(creaRigaPiatto());
  });

  // Il numero di persone non è più legato al numero di pietanze
  personeInput.addEventListener('input', () => { clearErr('persone'); });

  /* ============================================================
     DISPONIBILITÀ PER FASCIA ORARIA
     Carica i posti liberi di ogni slot e li mostra nel menu a
     tendina; gli slot esauriti vengono disabilitati.
     ========================================================== */
  let DISPONIBILITA = [];   // [{ orario, occupati, liberi }]

  function caricaDisponibilita() {
    if (!CONFIG.oggi) return;
    fetch('/api/disponibilita?data=' + encodeURIComponent(CONFIG.oggi))
      .then(r => r.json())
      .then(({ slot }) => { DISPONIBILITA = slot || []; buildOrario(); })
      .catch(() => { DISPONIBILITA = []; buildOrario(); });
  }

  function liberiPerOrario(hhmm) {
    const s = DISPONIBILITA.find(x => x.orario === hhmm);
    return s ? s.liberi : null;
  }

  /* ============================================================
     VALIDAZIONE
     ========================================================== */
  // Telefono internazionale (standard E.164): consente "+" opzionale all'inizio,
  // separatori comuni (spazi, trattini, punti, parentesi) e 7-15 cifre totali.
  // Funziona per numeri italiani, europei e di qualsiasi altro paese.
  function telefonoOk(v) {
    const s = String(v || '').trim();
    if (!/^[+]?[\d\s().\-/]{6,25}$/.test(s)) return false;
    const cifre = (s.match(/\d/g) || []).length;
    return cifre >= 7 && cifre <= 15;
  }
  function setErr(campo, msgKey) {
    const small = form.querySelector(`[data-err="${campo}"]`);
    if (small) small.textContent = msgKey ? t(msgKey) : '';
    const input = form.querySelector(`[name="${campo}"]`);
    if (input) input.classList.toggle('invalid', !!msgKey);
  }
  function clearErr(campo) { setErr(campo, ''); }

  ['nome', 'telefono', 'orario'].forEach(c => {
    const el = form.querySelector(`[name="${c}"]`);
    if (el) { el.addEventListener('input', () => clearErr(c)); el.addEventListener('change', () => clearErr(c)); }
  });

  function validate(dati, scelte) {
    let ok = true;
    if (!dati.nome || dati.nome.trim().length < 2) { setErr('nome', 'err_nome'); ok = false; }
    if (!telefonoOk(dati.telefono)) { setErr('telefono', 'err_telefono'); ok = false; }
    const n = parseInt(dati.persone, 10);
    if (!Number.isInteger(n) || n < 1) { setErr('persone', 'err_persone'); ok = false; }
    if (!dati.data || dati.data !== CONFIG.oggi) { setErr('data', 'err_data'); ok = false; }
    if (!dati.orario || !(CONFIG.slot || []).includes(dati.orario)) { setErr('orario', 'err_orario'); ok = false; }
    // Le pietanze sono FACOLTATIVE: nessun controllo di obbligatorietà.
    // Consenso privacy obbligatorio (GDPR)
    const privacyCheck = document.getElementById('privacyCheck');
    if (!privacyCheck || !privacyCheck.checked) { setErr('privacy', 'err_privacy'); ok = false; }
    return ok;
  }
  // Pulisce l'errore quando l'utente spunta il checkbox
  const _pc = document.getElementById('privacyCheck');
  if (_pc) _pc.addEventListener('change', () => setErr('privacy', ''));

  /* ============================================================
     INVIO PRENOTAZIONE
     ========================================================== */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formMsg.textContent = ''; formMsg.className = 'form-msg';

    const dati = Object.fromEntries(new FormData(form).entries());
    const scelte = [...guestDishes.querySelectorAll('select')].map(s => risolviPiatto(s.value));

    if (!validate(dati, scelte)) {
      const primo = form.querySelector('.invalid');
      if (primo) primo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    formMsg.textContent = t('msg_sending');

    const payload = {
      nome: dati.nome, telefono: dati.telefono,
      persone: dati.persone, data: dati.data, orario: dati.orario,
      note: dati.note || '',
      piatti: scelte.filter(Boolean).map(d => ({ tipo: d.tipo, nome: d.nome }))
    };

    try {
      const res = await fetch('/api/prenotazioni', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();

      if (out.ok) {
        const p = out.prenotazione;
        const testo = t('msg_ok')
          .replace('{nome}', p.nome)
          .replace('{persone}', p.persone)
          .replace('{data}', p.data)
          .replace('{orario}', window.I18N.formatTime(p.orario));
        formMsg.textContent = '✓ ' + testo;
        formMsg.className = 'form-msg ok';
        form.reset(); personeInput.value = 1;
        setupData(); buildGuestDishes();
        caricaDisponibilita();   // aggiorna i posti liberi degli slot
        // Nessun redirect a WhatsApp: la notifica al titolare parte dal server.
        // L'utente vede solo il messaggio di conferma qui sopra.
      } else {
        const map = { nome: 'err_nome', telefono: 'err_telefono', persone: 'err_persone', data: 'err_data', orario: 'err_orario' };
        if (map[out.codice]) setErr(out.codice, map[out.codice]);
        else if (out.codice === 'pieno') { formMsg.textContent = '✕ ' + t('msg_pieno'); formMsg.className = 'form-msg error'; caricaDisponibilita(); }
        else { formMsg.textContent = '✕ ' + t('msg_neterr'); formMsg.className = 'form-msg error'; }
      }
    } catch (err) {
      formMsg.textContent = '✕ ' + t('msg_neterr'); formMsg.className = 'form-msg error';
    }
  });

  /* ---------- Aggiornamento al cambio lingua ---------- */
  document.addEventListener('linguaCambiata', () => {
    buildOrario(); renderGridPiatti(); buildGuestDishes();
    // Aggiorna anche l'etichetta del pulsante menu, se presente
    const btn = document.getElementById('btnMenuView');
    if (btn) btn.textContent = t('menu_view');
    const una = menuArea && menuArea.querySelector('.menu-unavailable');
    if (una) una.textContent = t('menu_unavailable');
  });

  /* ---------- Utility anti-injection ---------- */
  function esc(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
});
