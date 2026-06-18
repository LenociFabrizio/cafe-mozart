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

  /* ---------- Selettore lingua (dropdown con bandiere) ---------- */
  const langSwitch  = document.getElementById('langSwitch');
  const langMenu    = document.getElementById('langMenu');
  const langBtn     = document.getElementById('langCurrent');
  const langFlag    = document.getElementById('langCurrentFlag');
  const langCode    = document.getElementById('langCurrentCode');
  const flagUrl     = (c) => `https://flagcdn.com/${c}.svg`;

  if (langSwitch && langMenu && window.LINGUE) {
    const closeLang = () => { langSwitch.classList.remove('open'); langBtn.setAttribute('aria-expanded', 'false'); };
    const openLang  = () => { langSwitch.classList.add('open');    langBtn.setAttribute('aria-expanded', 'true'); };

    // Aggiorna il pulsante corrente e l'evidenziazione nella lista
    const setLangUI = (code) => {
      const l = window.LINGUE.find(x => x.code === code) || window.LINGUE[0];
      langFlag.src = flagUrl(l.flag);
      langFlag.alt = l.label;
      langCode.textContent = l.code.toUpperCase();
      langMenu.querySelectorAll('li').forEach(li => li.classList.toggle('active', li.dataset.code === l.code));
    };

    // Costruisce le voci con bandiera + nome lingua
    window.LINGUE.forEach(({ code, label, flag }) => {
      const li = document.createElement('li');
      li.dataset.code = code;
      li.setAttribute('role', 'option');
      li.innerHTML = `<img class="lang-flag" src="${flagUrl(flag)}" alt="" width="20" height="15" /><span>${label}</span>`;
      li.addEventListener('click', () => { window.I18N.apply(code); setLangUI(code); closeLang(); });
      langMenu.appendChild(li);
    });

    setLangUI(window.I18N.init());

    langBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      langSwitch.classList.contains('open') ? closeLang() : openLang();
    });
    document.addEventListener('click', (e) => { if (!langSwitch.contains(e.target)) closeLang(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLang(); });
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
     Due carte: Drink List e Menu Bistrout. Stesso visualizzatore
     modale, parametrizzato per URL del PDF.
     ========================================================== */
  const pdfModal = document.getElementById('pdfModal');
  const pdfFrame = document.getElementById('pdfFrame');
  const pdfClose = document.getElementById('pdfClose');

  function aprePdf(url) {
    // Parametri PDF: nasconde la toolbar (incluso il tasto download nei viewer
    // che lo rispettano). Il contenuto resta visibile, navigabile e zoomabile.
    pdfFrame.src = `${url}#toolbar=0&navpanes=0&view=FitH`;
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

  // Stato di ogni menu, così da poter ri-renderizzare al cambio lingua.
  const MENU_CARDS = [
    { area: document.getElementById('menuArea'),         tipo: 'drink',    url: '/menu.pdf',          viewKey: 'menu_view',          disponibile: false },
    { area: document.getElementById('menuBistroutArea'), tipo: 'bistrout', url: '/menu-bistrout.pdf', viewKey: 'menu_bistrout_view', disponibile: false }
  ];

  function renderMenuCard(card) {
    if (!card.area) return;
    if (card.disponibile) {
      card.area.innerHTML = `<button type="button" class="btn btn-gold">${t(card.viewKey)}</button>`;
      card.area.querySelector('button').addEventListener('click', () => aprePdf(card.url));
    } else {
      card.area.innerHTML = `<p class="menu-unavailable">${t('menu_unavailable')}</p>`;
    }
  }

  MENU_CARDS.forEach(card => {
    if (!card.area) return;
    fetch('/api/menu?tipo=' + card.tipo)
      .then(r => r.json())
      .then(({ disponibile }) => { card.disponibile = !!disponibile; renderMenuCard(card); })
      .catch(() => { card.disponibile = false; renderMenuCard(card); });
  });

  /* ============================================================
     CAROSELLI — componente riutilizzabile (Cosa Offriamo)
     Enhance ogni elemento [data-carousel]: dots, frecce, autoplay,
     swipe touch, pausa al passaggio del mouse, reduce-motion.
     ========================================================== */
  function initCarousels() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelectorAll('[data-carousel]').forEach(carousel => {
      const track  = carousel.querySelector('.carousel-track');
      const slides = [...carousel.querySelectorAll('.carousel-slide')];
      if (!track || slides.length === 0) return;

      const dotsWrap = carousel.querySelector('.carousel-dots');
      const prevBtn  = carousel.querySelector('.carousel-btn.prev');
      const nextBtn  = carousel.querySelector('.carousel-btn.next');
      let index = 0;
      let timer = null;

      const dots = [];
      if (dotsWrap) {
        slides.forEach((_, i) => {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'carousel-dot' + (i === 0 ? ' active' : '');
          dot.setAttribute('aria-label', String(i + 1));
          dot.addEventListener('click', () => { go(i); restart(); });
          dotsWrap.appendChild(dot);
          dots.push(dot);
        });
      }

      function go(i) {
        index = (i + slides.length) % slides.length;
        track.style.transform = `translateX(-${index * 100}%)`;
        dots.forEach((d, di) => d.classList.toggle('active', di === index));
      }
      const next = () => go(index + 1);
      const prev = () => go(index - 1);

      if (nextBtn) nextBtn.addEventListener('click', () => { next(); restart(); });
      if (prevBtn) prevBtn.addEventListener('click', () => { prev(); restart(); });

      function start() { if (!reduce && slides.length > 1 && !timer) timer = setInterval(next, 5000); }
      function stop()  { if (timer) { clearInterval(timer); timer = null; } }
      function restart() { stop(); start(); }

      carousel.addEventListener('mouseenter', stop);
      carousel.addEventListener('mouseleave', start);

      // Swipe su touch
      let x0 = null;
      track.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
      track.addEventListener('touchend', (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 40) (dx < 0 ? next() : prev());
        x0 = null; start();
      }, { passive: true });

      go(0);
      start();
    });
  }
  initCarousels();

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
    const disponibili = DISHES_GIORNO.filter(d => d.stato !== 'esaurito');
    if (disponibili.length) {
      html += `<optgroup label="${t('cat_giorno')}">`;
      DISHES_GIORNO.forEach((d, i) => {
        if (d.stato === 'esaurito') return;
        const val = `giorno|${i}`;
        html += `<option value="${val}" ${val === selectedVal ? 'selected' : ''}>${esc(d.nome)}</option>`;
      });
      html += `</optgroup>`;
    }
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
    // Ri-renderizza entrambe le carte menu con le etichette tradotte
    MENU_CARDS.forEach(renderMenuCard);
  });

  /* ---------- Utility anti-injection ---------- */
  function esc(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }
});
