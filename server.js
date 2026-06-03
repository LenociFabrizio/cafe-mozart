/**
 * ============================================================
 *  Bistrout & Café Mozart — Server backend
 *  Stack: Node.js + Express
 * ------------------------------------------------------------
 *  Gestisce:
 *   - File statici del sito (cartella /public)
 *   - Menu del giorno (CRUD con stati: visibile/nascosto/esaurito)
 *   - Menu completo in PDF (Drink List, visualizzazione inline)
 *   - Prenotazioni con capienza PER FASCIA ORARIA (slot da 30')
 *   - Stati prenotazione: attesa / confermata / rifiutata / completata
 *   - Prenotazioni manuali / telefoniche / walk-in (lato admin)
 *   - Notifiche: link WhatsApp pre-compilati (titolare e cliente)
 *   - Notifiche: invio automatico al titolare via Telegram Bot API
 *     (gratuito, istantaneo, anti-duplicati, logging errori)
 * ============================================================
 */

// Carica le variabili d'ambiente dal file .env (se presente).
// In produzione le variabili sono di solito impostate direttamente
// dall'hosting; in quel caso il file .env non serve.
require('dotenv').config({ quiet: true });

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
 *  CONFIGURAZIONE (modificabile facilmente)
 * ========================================================== */
const ADMIN_PASSWORD = 'mozart2024';

/* ------------------------------------------------------------
 *  NOTIFICHE TELEGRAM (canale primario, gratuito)
 * ------------------------------------------------------------
 *  Ad ogni nuova prenotazione il sistema invia automaticamente
 *  un messaggio Telegram al titolare con tutti i dati.
 *  Vantaggi: gratis per sempre, istantaneo (push native di
 *  Telegram), nessuna libreria da installare (basta fetch).
 *
 *  Variabili d'ambiente da impostare sul server (NON nel codice):
 *
 *    TELEGRAM_BOT_TOKEN = 1234567:ABC-DEF...   (token del bot)
 *    TELEGRAM_CHAT_ID   = 123456789            (ID destinatario)
 *
 *  Come ottenere queste due informazioni:
 *
 *   1) Apri Telegram, cerca "@BotFather" e avvia una chat.
 *      Comando /newbot, dai un nome (es. "Bistrout Notifiche"),
 *      uno username (es. bistrout_notifiche_bot). Riceverai un
 *      TOKEN del tipo "1234567:ABC-DEF..." -> TELEGRAM_BOT_TOKEN.
 *
 *   2) Cerca il bot appena creato (con lo username che hai
 *      scelto), aprilo e premi "Avvia" / scrivi /start.
 *      Questo passaggio è OBBLIGATORIO: il bot può scrivere solo
 *      a chi gli ha scritto per primo almeno una volta.
 *
 *   3) Per scoprire il TELEGRAM_CHAT_ID apri nel browser:
 *        https://api.telegram.org/bot<TOKEN>/getUpdates
 *      (sostituendo <TOKEN> col tuo). Cerca "chat":{"id": ...}:
 *      quel numero è il TELEGRAM_CHAT_ID.
 *
 *  Se le credenziali mancano, il sistema NON va in errore:
 *  registra la notifica nei log (modalità "simulazione") e la
 *  prenotazione viene comunque salvata e mostrata. */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const TELEGRAM_ATTIVO    = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

if (TELEGRAM_ATTIVO) {
  console.log('  [notifiche] Telegram attivo — chat ID:', TELEGRAM_CHAT_ID);
} else {
  console.log('  [notifiche] Credenziali Telegram assenti: invio in modalità simulazione (log).');
}

/* Anti-duplicati: tiene gli ID delle prenotazioni già notificate negli
 * ultimi 5 minuti, così doppi click / retry / refresh non generano
 * notifiche ripetute. Si pulisce da solo allo scadere del TTL. */
const NOTIFICHE_RECENTI = new Map();   // id -> timestamp
const ANTIDUP_TTL_MS = 5 * 60 * 1000;  // 5 minuti
function giàNotificata(id) {
  const ora = Date.now();
  // Pulizia opportunistica delle voci scadute
  for (const [k, t] of NOTIFICHE_RECENTI) if (ora - t > ANTIDUP_TTL_MS) NOTIFICHE_RECENTI.delete(k);
  if (NOTIFICHE_RECENTI.has(String(id))) return true;
  NOTIFICHE_RECENTI.set(String(id), ora);
  return false;
}

/* Fascia oraria del Menu del Giorno / prenotazioni (HH:MM 24h). */
const ORARIO_INIZIO = '12:00';
const ORARIO_FINE   = '14:30';
const SLOT_MINUTI   = 30;   // ogni mezz'ora

/* Capienza del locale: 20 posti PER OGNI fascia oraria da 30 minuti.
 * Ogni slot ha quindi la propria disponibilità indipendente. */
const POSTI_PER_SLOT = 20;

/* Percorsi dei file di dati */
const DATA_DIR = path.join(__dirname, 'data');
const PIATTI_FILE = path.join(DATA_DIR, 'piatti.json');       // ora JSON (per gli stati)
const PIATTI_TXT_LEGACY = path.join(DATA_DIR, 'piatti.txt');  // vecchio formato (migrazione)
const PRENOTAZIONI_FILE = path.join(DATA_DIR, 'prenotazioni.json');
const MENU_PDF_FILE = path.join(DATA_DIR, 'menu.pdf');

/* Crea cartella e file di dati se non esistono */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRENOTAZIONI_FILE)) fs.writeFileSync(PRENOTAZIONI_FILE, '[]', 'utf8');

/* ============================================================
 *  MIDDLEWARE
 * ========================================================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* Upload menu in PDF (Drink List) */
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 10 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error('Sono ammessi solo file .pdf'));
  }
});

/* ============================================================
 *  PIATTI — Menu del Giorno (con stati)
 *  Ogni piatto: { nome, descrizione, prezzo, stato }
 *  stato ∈ 'visibile' | 'nascosto' | 'esaurito'
 * ========================================================== */

/** Migra l'eventuale vecchio piatti.txt al nuovo piatti.json. */
function migraPiattiSeNecessario() {
  if (fs.existsSync(PIATTI_FILE)) return;
  let iniziali = [];
  if (fs.existsSync(PIATTI_TXT_LEGACY)) {
    try {
      iniziali = fs.readFileSync(PIATTI_TXT_LEGACY, 'utf8')
        .split('\n').map(r => r.trim()).filter(r => r.length > 0)
        .map(r => {
          const parti = r.split('|').map(x => x.trim());
          return { nome: parti[0], descrizione: parti[1] || '', prezzo: null, stato: 'visibile' };
        });
    } catch (e) { iniziali = []; }
  }
  fs.writeFileSync(PIATTI_FILE, JSON.stringify(iniziali, null, 2), 'utf8');
}
migraPiattiSeNecessario();

/** Legge tutti i piatti (con tutti gli stati). */
function leggiPiatti() {
  try {
    const arr = JSON.parse(fs.readFileSync(PIATTI_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.map(normalizzaPiatto) : [];
  } catch (err) {
    console.error('Errore lettura piatti:', err);
    return [];
  }
}
function normalizzaPiatto(p) {
  const stato = ['visibile', 'nascosto', 'esaurito'].includes(p.stato) ? p.stato : 'visibile';
  let prezzo = (p.prezzo === '' || p.prezzo === undefined || p.prezzo === null) ? null : Number(p.prezzo);
  if (!Number.isFinite(prezzo)) prezzo = null;
  return {
    nome: String(p.nome || '').trim(),
    descrizione: String(p.descrizione || '').trim(),
    prezzo,
    stato
  };
}
function scriviPiatti(lista) {
  fs.writeFileSync(PIATTI_FILE, JSON.stringify((lista || []).map(normalizzaPiatto), null, 2), 'utf8');
}

/** Validazione di un piatto inviato dall'admin. */
function validaPiatto(p) {
  if (!p || typeof p !== 'object') return 'dati non validi';
  const nome = String(p.nome || '').trim();
  if (nome.length < 2) return 'Il nome del piatto è obbligatorio (minimo 2 caratteri).';
  if (nome.length > 80) return 'Il nome è troppo lungo (max 80 caratteri).';
  const desc = String(p.descrizione || '').trim();
  if (desc.length > 200) return 'La descrizione è troppo lunga (max 200 caratteri).';
  if (p.prezzo !== undefined && p.prezzo !== null && p.prezzo !== '') {
    const pr = Number(p.prezzo);
    if (!Number.isFinite(pr) || pr < 0 || pr > 999) return 'Prezzo non valido.';
  }
  if (p.stato !== undefined && !['visibile', 'nascosto', 'esaurito'].includes(p.stato)) return 'Stato non valido.';
  return null;
}

/* ============================================================
 *  PRENOTAZIONI
 * ========================================================== */
function leggiPrenotazioni() {
  try { return JSON.parse(fs.readFileSync(PRENOTAZIONI_FILE, 'utf8')); }
  catch (err) { return []; }
}
function salvaPrenotazioni(lista) {
  fs.writeFileSync(PRENOTAZIONI_FILE, JSON.stringify(lista, null, 2), 'utf8');
}

/** Data di oggi (locale) in formato YYYY-MM-DD. */
function oggiISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}
function aMinuti(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; }

/** Genera gli slot orari validi (es. 12:00, 12:30, 13:00, 13:30, 14:00, 14:30). */
function generaSlot() {
  const slot = [];
  for (let m = aMinuti(ORARIO_INIZIO); m <= aMinuti(ORARIO_FINE); m += SLOT_MINUTI) {
    slot.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return slot;
}

/** Gli stati che OCCUPANO un posto (contano per la capienza). */
const STATI_ATTIVI = ['attesa', 'confermata'];

/** Posti occupati per un certo giorno+slot (somma persone delle prenotazioni attive). */
function copertiSlot(prenotazioni, data, orario, escludiId = null) {
  return prenotazioni
    .filter(p => p.data === data && p.orario === orario
      && STATI_ATTIVI.includes(p.stato || 'attesa')
      && String(p.id) !== String(escludiId))
    .reduce((s, p) => s + (Number(p.persone) || 0), 0);
}

/** Disponibilità di ogni slot per un giorno: [{ orario, occupati, liberi }]. */
function disponibilitaGiorno(prenotazioni, data) {
  return generaSlot().map(orario => {
    const occupati = copertiSlot(prenotazioni, data, orario);
    return { orario, occupati, liberi: Math.max(0, POSTI_PER_SLOT - occupati) };
  });
}

function telefonoValido(v) {
  const s = String(v || '').trim();
  if (!/^[+]?[\d\s().\-/]{6,25}$/.test(s)) return false;
  const cifre = (s.match(/\d/g) || []).length;
  return cifre >= 7 && cifre <= 15;
}

/* ============================================================
 *  NOTIFICHE EMAIL
 * ------------------------------------------------------------
 *  Canale primario: email transazionale al titolare via SMTP
 *  (Nodemailer). Gratuita con Gmail "password per le app".
 *  Modalità simulazione automatica se manca la configurazione
 *  (le notifiche finiscono nei log; la prenotazione viene
 *  comunque salvata e mostrata).
 *
 *  Resta disponibile linkMessaggioCliente() per generare un
 *  link wa.me pre-compilato come *fallback manuale* (un click
 *  che il titolare può scegliere di fare dalla dashboard quando
 *  conferma/rifiuta una prenotazione). Non è una notifica
 *  automatica, è solo un link gratuito.
 * ========================================================== */

function etichettaOrigine(o) {
  return ({ online: 'Online', telefonica: 'Telefonica', walkin: 'Walk-in', manuale: 'Manuale' })[o] || 'Online';
}

/** Costruisce il testo "plain text" della notifica (per client email
 *  che non leggono l'HTML, e per fallback nei log). */
function costruisciTestoNotificaTitolare(p) {
  const piatti = (p.piatti && p.piatti.length)
    ? p.piatti.map(d => `• ${d.nome} (${d.tipo === 'carta' ? 'Drink List' : 'Menu del Giorno'})`).join('\n')
    : 'Nessuna pietanza selezionata';
  return [
    `NUOVA PRENOTAZIONE — Bistrout & Café Mozart`,
    `Origine: ${etichettaOrigine(p.origine)}`,
    `Nome: ${p.nome}`,
    `Telefono: ${p.telefono || '—'}`,
    `Data: ${p.data}`,
    `Orario: ${p.orario}`,
    `Persone: ${p.persone}`,
    `Note: ${p.note || '—'}`,
    `Pietanze:`,
    piatti
  ].join('\n');
}

/** Escape HTML per Telegram (supporta solo &, <, > in HTML mode).
 *  Usato per inserire dati utente nel template senza rompere il parsing. */
function escTg(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Template HTML Telegram per la notifica al titolare.
 *  Telegram accetta un sottoinsieme di HTML: <b>, <i>, <u>, <s>,
 *  <code>, <pre>, <a href="...">. Niente <br>, niente <table>:
 *  la formattazione si fa con i newline e gli emoji. */
function costruisciTelegramNotificaTitolare(p) {
  const piattiBlock = (p.piatti && p.piatti.length)
    ? p.piatti.map(d => `   • <i>${escTg(d.tipo === 'carta' ? 'Drink List' : 'Menu del Giorno')}</i> — ${escTg(d.nome)}`).join('\n')
    : '   <i>Nessuna pietanza selezionata</i>';

  const telefonoRiga = p.telefono ? `📞 <b>Telefono:</b> ${escTg(p.telefono)}` : '📞 <b>Telefono:</b> —';
  const noteRiga = p.note ? `\n📝 <b>Note:</b> <i>${escTg(p.note)}</i>` : '';

  return [
    `🔔 <b>NUOVA PRENOTAZIONE</b>`,
    `🏷 <i>${escTg(etichettaOrigine(p.origine))}</i>`,
    ``,
    `👤 <b>${escTg(p.nome)}</b>`,
    telefonoRiga,
    ``,
    `📅 <b>Data:</b> ${escTg(p.data)}`,
    `🕐 <b>Orario:</b> ${escTg(p.orario)}`,
    `👥 <b>Persone:</b> ${escTg(p.persone)}`,
    ``,
    `🍽 <b>Pietanze:</b>`,
    piattiBlock + noteRiga,
    ``,
    `⏳ <i>In attesa di conferma</i>`
  ].join('\n');
}

/** Link wa.me pre-compilato (usato come fallback manuale nella dashboard). */
function linkMessaggioCliente(p, testo) {
  const tel = String(p.telefono || '').replace(/[^\d]/g, '');
  if (!tel) return null;
  const numero = tel.length === 10 && tel.startsWith('3') ? '39' + tel : tel;
  return `https://wa.me/${numero}?text=${encodeURIComponent(testo)}`;
}

/** Invia un messaggio Telegram al titolare via Bot API.
 *  Usa fetch nativo (Node 18+) — nessuna libreria esterna.
 *  Restituisce Promise<boolean>. Errori solo loggati: la
 *  prenotazione non si blocca mai per un fallimento di notifica. */
async function inviaTelegram(testoHtml) {
  if (!TELEGRAM_ATTIVO) {
    console.log('[notifiche][SIMULAZIONE] Telegram non configurato.');
    console.log('--- messaggio ---\n' + testoHtml.replace(/<\/?[^>]+>/g, '') + '\n-----------------');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: testoHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      console.error('[notifiche] ERRORE Telegram:', data.description || resp.statusText);
      return false;
    }
    console.log('[notifiche] Telegram inviato — message_id:', data.result.message_id);
    return true;
  } catch (err) {
    console.error('[notifiche] ERRORE rete Telegram:', err && err.message ? err.message : err);
    return false;
  }
}

/** Notifica il TITOLARE di una nuova prenotazione via Telegram.
 *  Protetta contro invii duplicati per lo stesso id nei 5 minuti. */
async function notificaTitolare(prenotazione) {
  if (giàNotificata(prenotazione.id)) {
    console.log('[notifiche] Notifica già inviata per id', prenotazione.id, '— saltata (anti-duplicato).');
    return false;
  }
  const testoHtml = costruisciTelegramNotificaTitolare(prenotazione);
  return inviaTelegram(testoHtml);
}

/* ============================================================
 *  API PUBBLICHE
 * ========================================================== */

/* Configurazione per il form di prenotazione */
app.get('/api/config', (req, res) => {
  res.json({
    orarioInizio: ORARIO_INIZIO,
    orarioFine: ORARIO_FINE,
    slot: generaSlot(),
    oggi: oggiISO(),
    postiPerSlot: POSTI_PER_SLOT
  });
});

/* Disponibilità per fascia oraria di un dato giorno (default: oggi) */
app.get('/api/disponibilita', (req, res) => {
  const data = req.query.data || oggiISO();
  res.json({ data, postiPerSlot: POSTI_PER_SLOT, slot: disponibilitaGiorno(leggiPrenotazioni(), data) });
});

/* Menu del Giorno — solo i piatti mostrabili al pubblico (visibili o esauriti) */
app.get('/api/piatti', (req, res) => {
  const pubblici = leggiPiatti()
    .filter(p => p.stato !== 'nascosto')
    .map((p, i) => ({ nome: p.nome, descrizione: p.descrizione, prezzo: p.prezzo, stato: p.stato }));
  res.json({ piatti: pubblici });
});

/* Disponibilità menu PDF */
app.get('/api/menu', (req, res) => {
  res.json({ disponibile: fs.existsSync(MENU_PDF_FILE), url: '/menu.pdf' });
});

/* Visualizzazione menu PDF (inline, non download) */
app.get('/menu.pdf', (req, res) => {
  if (!fs.existsSync(MENU_PDF_FILE)) return res.status(404).send('Menu non disponibile.');
  res.sendFile(MENU_PDF_FILE);
});

/* ------------------------------------------------------------
 *  POST /api/prenotazioni  ->  prenotazione pubblica (solo oggi)
 *  Piatti FACOLTATIVI. Capienza controllata per fascia oraria.
 * ---------------------------------------------------------- */
app.post('/api/prenotazioni', async (req, res) => {
  const { nome, persone, data, orario, telefono, piatti, note } = req.body;
  const nPersone = Number(persone);

  if (!nome || String(nome).trim().length < 2) return res.status(400).json({ ok: false, codice: 'nome' });
  if (!telefonoValido(telefono)) return res.status(400).json({ ok: false, codice: 'telefono' });
  if (!Number.isInteger(nPersone) || nPersone < 1) return res.status(400).json({ ok: false, codice: 'persone' });

  const oggi = oggiISO();
  if (!data || data !== oggi) return res.status(400).json({ ok: false, codice: 'data' });
  if (!orario || !generaSlot().includes(orario)) return res.status(400).json({ ok: false, codice: 'orario' });

  // I piatti sono FACOLTATIVI: si accetta anche nessuna selezione.
  const sceltePiatti = Array.isArray(piatti) ? piatti.filter(p => p && p.nome) : [];

  // Controllo capienza per la fascia oraria scelta
  const prenotazioni = leggiPrenotazioni();
  const occupati = copertiSlot(prenotazioni, data, orario);
  const liberi = Math.max(0, POSTI_PER_SLOT - occupati);
  if (nPersone > liberi) {
    return res.status(409).json({
      ok: false, codice: 'pieno', liberi,
      slot: disponibilitaGiorno(prenotazioni, data)
    });
  }

  const nuova = creaPrenotazione({
    nome, telefono, persone: nPersone, data, orario,
    piatti: sceltePiatti, note, origine: 'online', stato: 'attesa'
  });
  prenotazioni.push(nuova);
  salvaPrenotazioni(prenotazioni);

  // Notifica WhatsApp al titolare SERVER-SIDE (nessun redirect per l'utente).
  // L'attesa è "best effort": un eventuale errore di invio viene loggato ma
  // non fa fallire la prenotazione, che resta comunque salvata.
  let notificaInviata = false;
  try { notificaInviata = await notificaTitolare(nuova); }
  catch (e) { console.error('[notifiche] Errore imprevisto:', e); }

  res.json({ ok: true, codice: 'ok', prenotazione: nuova, notificaInviata });
});

/** Crea l'oggetto prenotazione normalizzato. */
function creaPrenotazione(d) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    nome: String(d.nome).trim(),
    telefono: String(d.telefono || '').trim(),
    persone: Number(d.persone),
    data: d.data,
    orario: d.orario,
    piatti: (d.piatti || []).map(p => ({ tipo: p.tipo === 'carta' ? 'carta' : 'giorno', nome: String(p.nome).trim() })),
    note: d.note ? String(d.note).trim() : '',
    origine: ['online', 'telefonica', 'walkin', 'manuale'].includes(d.origine) ? d.origine : 'online',
    stato: ['attesa', 'confermata', 'rifiutata', 'completata'].includes(d.stato) ? d.stato : 'attesa',
    // Stato cucina (KDS): flusso indipendente dallo stato della prenotazione.
    // nuova -> in_preparazione -> pronta -> consegnata
    statoCucina: ['nuova', 'in_preparazione', 'pronta', 'consegnata'].includes(d.statoCucina) ? d.statoCucina : 'nuova',
    creataIl: new Date().toISOString()
  };
}

/* ============================================================
 *  API ADMIN (protette da password)
 * ========================================================== */

function authOk(req) {
  const pwd = req.body && req.body.password !== undefined ? req.body.password : req.query.password;
  return pwd === ADMIN_PASSWORD;
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, messaggio: 'Password errata.' });
});

/* ---------- Gestione Menu del Giorno (CRUD + stati) ---------- */

/* Tutti i piatti, con stato (per l'admin) */
app.get('/api/admin/piatti', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  res.json({ ok: true, piatti: leggiPiatti() });
});

app.post('/api/admin/piatti/aggiungi', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const errore = validaPiatto(req.body.piatto);
  if (errore) return res.status(400).json({ ok: false, messaggio: errore });
  try {
    const lista = leggiPiatti();
    lista.push(normalizzaPiatto({ ...req.body.piatto, stato: req.body.piatto.stato || 'visibile' }));
    scriviPiatti(lista);
    res.json({ ok: true, messaggio: 'Piatto aggiunto.', piatti: leggiPiatti() });
  } catch (err) { res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' }); }
});

app.post('/api/admin/piatti/modifica', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const indice = Number(req.body.indice);
  const errore = validaPiatto(req.body.piatto);
  if (errore) return res.status(400).json({ ok: false, messaggio: errore });
  try {
    const lista = leggiPiatti();
    if (!Number.isInteger(indice) || indice < 0 || indice >= lista.length)
      return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    // Mantiene lo stato esistente se non passato
    const statoFinale = req.body.piatto.stato || lista[indice].stato;
    lista[indice] = normalizzaPiatto({ ...req.body.piatto, stato: statoFinale });
    scriviPiatti(lista);
    res.json({ ok: true, messaggio: 'Piatto aggiornato.', piatti: leggiPiatti() });
  } catch (err) { res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' }); }
});

/* Cambia solo lo stato (visibile / nascosto / esaurito) */
app.post('/api/admin/piatti/stato', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const indice = Number(req.body.indice);
  const stato = req.body.stato;
  if (!['visibile', 'nascosto', 'esaurito'].includes(stato))
    return res.status(400).json({ ok: false, messaggio: 'Stato non valido.' });
  try {
    const lista = leggiPiatti();
    if (!Number.isInteger(indice) || indice < 0 || indice >= lista.length)
      return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    lista[indice].stato = stato;
    scriviPiatti(lista);
    res.json({ ok: true, messaggio: 'Stato aggiornato.', piatti: leggiPiatti() });
  } catch (err) { res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' }); }
});

app.post('/api/admin/piatti/elimina', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const indice = Number(req.body.indice);
  try {
    const lista = leggiPiatti();
    if (!Number.isInteger(indice) || indice < 0 || indice >= lista.length)
      return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    lista.splice(indice, 1);
    scriviPiatti(lista);
    res.json({ ok: true, messaggio: 'Piatto eliminato.', piatti: leggiPiatti() });
  } catch (err) { res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' }); }
});

/* Upload menu PDF */
app.post('/api/admin/menu', uploadPdf.single('file'), (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  if (!req.file) return res.status(400).json({ ok: false, messaggio: 'Nessun file caricato.' });
  try {
    fs.writeFileSync(MENU_PDF_FILE, req.file.buffer);
    res.json({ ok: true, messaggio: 'Menu PDF aggiornato con successo.' });
  } catch (err) { res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio del menu.' }); }
});

/* ---------- Gestione prenotazioni (admin) ---------- */

/* Elenco prenotazioni + config + disponibilità del giorno richiesto */
app.get('/api/admin/prenotazioni', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const data = req.query.data || oggiISO();
  const prenotazioni = leggiPrenotazioni();
  res.json({
    ok: true,
    prenotazioni,
    config: { postiPerSlot: POSTI_PER_SLOT, slot: generaSlot(), oggi: oggiISO() },
    disponibilita: disponibilitaGiorno(prenotazioni, data)
  });
});

/* Crea prenotazione manuale / telefonica / walk-in (lato admin) */
app.post('/api/admin/prenotazioni/crea', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { nome, telefono, persone, data, orario, piatti, note, origine, stato } = req.body;
  const nPersone = Number(persone);

  if (!nome || String(nome).trim().length < 2) return res.status(400).json({ ok: false, messaggio: 'Nome non valido.' });
  if (!Number.isInteger(nPersone) || nPersone < 1) return res.status(400).json({ ok: false, messaggio: 'Numero persone non valido.' });
  if (!data) return res.status(400).json({ ok: false, messaggio: 'Data mancante.' });
  if (!orario || !generaSlot().includes(orario)) return res.status(400).json({ ok: false, messaggio: 'Orario non valido.' });
  // Per le prenotazioni admin il telefono è facoltativo (es. walk-in)
  if (telefono && !telefonoValido(telefono)) return res.status(400).json({ ok: false, messaggio: 'Telefono non valido.' });

  const prenotazioni = leggiPrenotazioni();
  // Controllo capienza (l'admin può forzare l'overbooking con forza=true)
  const occupati = copertiSlot(prenotazioni, data, orario);
  const liberi = Math.max(0, POSTI_PER_SLOT - occupati);
  if (nPersone > liberi && !req.body.forza) {
    return res.status(409).json({ ok: false, codice: 'pieno', liberi, messaggio: `Solo ${liberi} posti liberi in quella fascia. Conferma per forzare l'overbooking.` });
  }

  const nuova = creaPrenotazione({
    nome, telefono, persone: nPersone, data, orario,
    piatti: Array.isArray(piatti) ? piatti : [],
    note,
    origine: origine || 'manuale',
    stato: stato || 'confermata'   // le prenotazioni inserite dal locale sono già confermate
  });
  prenotazioni.push(nuova);
  salvaPrenotazioni(prenotazioni);
  res.json({ ok: true, prenotazione: nuova });
});

/* Modifica una prenotazione esistente (admin) */
app.post('/api/admin/prenotazioni/modifica', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, nome, telefono, persone, data, orario, note } = req.body;
  const lista = leggiPrenotazioni();
  const pren = lista.find(p => String(p.id) === String(id));
  if (!pren) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });

  const nPersone = Number(persone);
  if (!nome || String(nome).trim().length < 2) return res.status(400).json({ ok: false, messaggio: 'Nome non valido.' });
  if (!Number.isInteger(nPersone) || nPersone < 1) return res.status(400).json({ ok: false, messaggio: 'Numero persone non valido.' });
  if (!orario || !generaSlot().includes(orario)) return res.status(400).json({ ok: false, messaggio: 'Orario non valido.' });
  if (telefono && !telefonoValido(telefono)) return res.status(400).json({ ok: false, messaggio: 'Telefono non valido.' });

  // Capienza nel nuovo slot, escludendo la prenotazione stessa
  const occupati = copertiSlot(lista, data || pren.data, orario, pren.id);
  const liberi = Math.max(0, POSTI_PER_SLOT - occupati);
  if (nPersone > liberi && !req.body.forza)
    return res.status(409).json({ ok: false, codice: 'pieno', liberi, messaggio: `Solo ${liberi} posti liberi in quella fascia.` });

  pren.nome = String(nome).trim();
  pren.telefono = String(telefono || '').trim();
  pren.persone = nPersone;
  if (data) pren.data = data;
  pren.orario = orario;
  pren.note = note ? String(note).trim() : '';
  salvaPrenotazioni(lista);
  res.json({ ok: true, prenotazione: pren });
});

/* Cambia stato: attesa / confermata / rifiutata / completata
 * Su conferma/rifiuto invia automaticamente la notifica al cliente via
 * Twilio (server-side). Restituisce comunque un linkCliente di fallback
 * (utile se Twilio non è configurato e l'invio resta in simulazione). */
app.post('/api/admin/prenotazioni/stato', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, stato } = req.body;
  if (!['attesa', 'confermata', 'rifiutata', 'completata'].includes(stato))
    return res.status(400).json({ ok: false, messaggio: 'Stato non valido.' });

  const lista = leggiPrenotazioni();
  const pren = lista.find(p => String(p.id) === String(id));
  if (!pren) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });
  pren.stato = stato;
  salvaPrenotazioni(lista);

  // Per il CLIENTE non c'è un invio automatico (non chiediamo l'email
  // in prenotazione). Il titolare può comunque avvisare il cliente con
  // un solo click dalla dashboard, tramite il linkCliente (wa.me).
  let linkCliente = null;
  let testo = null;
  if (stato === 'confermata') {
    testo = `Gentile ${pren.nome}, la Sua prenotazione presso Bistrout & Café Mozart per ${pren.persone} ${Number(pren.persone) === 1 ? 'persona' : 'persone'} il ${pren.data} alle ${pren.orario} è stata CONFERMATA. La aspettiamo!`;
  } else if (stato === 'rifiutata') {
    const alternativi = disponibilitaGiorno(lista, pren.data).filter(s => s.liberi >= pren.persone).map(s => s.orario);
    const propostaOrari = alternativi.length ? ` Le proponiamo questi orari alternativi: ${alternativi.join(', ')}.` : '';
    testo = `Gentile ${pren.nome}, siamo spiacenti ma non possiamo accogliere la Sua prenotazione del ${pren.data} alle ${pren.orario}.${propostaOrari} Per assistenza ci contatti al telefono. Grazie.`;
  }
  if (testo && pren.telefono) linkCliente = linkMessaggioCliente(pren, testo);

  res.json({ ok: true, prenotazione: pren, linkCliente });
});

/* Cambia lo STATO CUCINA (Kitchen Display): nuova / in_preparazione / pronta / consegnata.
 * Flusso indipendente dallo stato della prenotazione, usato dalla pagina cucina.html. */
app.post('/api/admin/prenotazioni/stato-cucina', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, statoCucina } = req.body;
  if (!['nuova', 'in_preparazione', 'pronta', 'consegnata'].includes(statoCucina))
    return res.status(400).json({ ok: false, messaggio: 'Stato cucina non valido.' });

  const lista = leggiPrenotazioni();
  const pren = lista.find(p => String(p.id) === String(id));
  if (!pren) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });
  pren.statoCucina = statoCucina;
  salvaPrenotazioni(lista);
  res.json({ ok: true, prenotazione: pren });
});

/* Elimina una prenotazione */
app.post('/api/admin/prenotazioni/elimina', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id } = req.body;
  const lista = leggiPrenotazioni();
  const nuova = lista.filter(p => String(p.id) !== String(id));
  if (nuova.length === lista.length) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });
  salvaPrenotazioni(nuova);
  res.json({ ok: true });
});

/* ============================================================
 *  AVVIO SERVER
 * ========================================================== */
app.listen(PORT, () => {
  console.log(`\n  Bistrout & Café Mozart è online!`);
  console.log(`  Sito:         http://localhost:${PORT}`);
  console.log(`  Admin:        http://localhost:${PORT}/admin.html`);
  console.log(`  Prenotazioni: http://localhost:${PORT}/prenotazioni.html\n`);
});
