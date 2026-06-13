/**
 * ============================================================
 *  Bistrout & Café Mozart — Server backend
 *  Stack: Node.js + Express + Neon PostgreSQL (serverless)
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
 *
 *  Dati persistenti su Neon PostgreSQL (compatibile Vercel serverless).
 *  Schema: db/schema.sql  |  Migrazione dati: npm run seed
 * ============================================================
 */

require('dotenv').config({ quiet: true });

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { neon } = require('@neondatabase/serverless');
const bcrypt   = require('bcryptjs');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
 *  CONFIGURAZIONE
 * ========================================================== */
const ADMIN_PASSWORD     = process.env.ADMIN_PASSWORD     || 'mozart2024';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_IDS  = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_ATTIVO    = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS.length);

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const TWILIO_ATTIVO      = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);

if (!process.env.DATABASE_URL) {
  console.warn('  [db] ATTENZIONE: DATABASE_URL non impostata. Le API dati non funzioneranno.');
}

if (TELEGRAM_ATTIVO) {
  console.log('  [notifiche] Telegram attivo — chat IDs:', TELEGRAM_CHAT_IDS.join(', '));
} else {
  console.log('  [notifiche] Credenziali Telegram assenti: modalità simulazione (log).');
}

if (TWILIO_ATTIVO) {
  console.log('  [sms] Twilio attivo — da:', TWILIO_FROM_NUMBER);
} else {
  console.log('  [sms] Credenziali Twilio assenti: SMS in modalità simulazione (log).');
}

/* Connessione al database Neon (HTTP-based, ottimale per serverless) */
const sql = neon(process.env.DATABASE_URL || 'postgresql://noop:noop@noop/noop');

/* Auto-migrazione: crea le tabelle se non esistono ancora.
 * Viene eseguita al cold-start (module load). Le istruzioni IF NOT EXISTS
 * sono idempotenti: sicure da ripetere ad ogni avvio. */
async function autoMigrate() {
  if (!process.env.DATABASE_URL) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS piatti (
        id          SERIAL PRIMARY KEY,
        nome        VARCHAR(80)  NOT NULL,
        descrizione VARCHAR(200) NOT NULL DEFAULT '',
        prezzo      NUMERIC(6,2),
        stato       VARCHAR(20)  NOT NULL DEFAULT 'visibile',
        ordine      INT          NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT piatti_stato_check CHECK (stato IN ('visibile','nascosto','esaurito'))
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS prenotazioni (
        id           BIGINT       PRIMARY KEY,
        nome         VARCHAR(100) NOT NULL,
        telefono     VARCHAR(30)  NOT NULL DEFAULT '',
        persone      INT          NOT NULL,
        data         DATE         NOT NULL,
        orario       VARCHAR(5)   NOT NULL,
        note         TEXT         NOT NULL DEFAULT '',
        origine      VARCHAR(20)  NOT NULL DEFAULT 'online',
        stato        VARCHAR(20)  NOT NULL DEFAULT 'attesa',
        stato_cucina VARCHAR(20)  NOT NULL DEFAULT 'nuova',
        creata_il    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT prenotazioni_stato_check        CHECK (stato        IN ('attesa','confermata','rifiutata','completata')),
        CONSTRAINT prenotazioni_stato_cucina_check CHECK (stato_cucina IN ('nuova','in_preparazione','pronta','consegnata')),
        CONSTRAINT prenotazioni_origine_check      CHECK (origine      IN ('online','telefonica','walkin','manuale'))
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS prenotazione_piatti (
        id              SERIAL  PRIMARY KEY,
        prenotazione_id BIGINT  NOT NULL REFERENCES prenotazioni(id) ON DELETE CASCADE,
        tipo            VARCHAR(20) NOT NULL DEFAULT 'giorno',
        nome            VARCHAR(80) NOT NULL,
        ordine          INT     NOT NULL DEFAULT 0,
        CONSTRAINT pren_piatti_tipo_check CHECK (tipo IN ('giorno','carta'))
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS menu_pdf (
        id            INT         PRIMARY KEY DEFAULT 1,
        data_base64   TEXT,
        aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS admin_credenziali (
        id             INT         PRIMARY KEY DEFAULT 1,
        password_hash  TEXT        NOT NULL,
        aggiornato_il  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const existing = await sql`SELECT id FROM admin_credenziali WHERE id = 1`;
    if (!existing.length) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await sql`INSERT INTO admin_credenziali (id, password_hash) VALUES (1, ${hash})`;
      console.log('[migrate] Password admin inizializzata nel DB.');
    }
    console.log('[migrate] Schema verificato.');
  } catch (e) {
    console.error('[migrate] Errore auto-migrazione:', e.message);
  }
}
autoMigrate();

/* Anti-duplicati notifiche (in-memory, best-effort in ambienti serverless:
 * nei cold-start la Map si azzera, al massimo si rischia una notifica doppia) */
const NOTIFICHE_RECENTI = new Map();
const ANTIDUP_TTL_MS    = 5 * 60 * 1000;
function giàNotificata(id) {
  const ora = Date.now();
  for (const [k, t] of NOTIFICHE_RECENTI) if (ora - t > ANTIDUP_TTL_MS) NOTIFICHE_RECENTI.delete(k);
  if (NOTIFICHE_RECENTI.has(String(id))) return true;
  NOTIFICHE_RECENTI.set(String(id), ora);
  return false;
}

/* Fascia oraria del Menu del Giorno / prenotazioni (HH:MM 24h) */
const ORARIO_INIZIO  = '12:00';
const ORARIO_FINE    = '14:30';
const SLOT_MINUTI    = 30;
const POSTI_PER_SLOT = 20;

/* ============================================================
 *  MIDDLEWARE
 * ========================================================== */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* Upload menu PDF in memoria (buffer, nessuna scrittura su disco) */
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 10 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf'))
      cb(null, true);
    else cb(new Error('Sono ammessi solo file .pdf'));
  }
});

/* ============================================================
 *  HELPERS GENERICI
 * ========================================================== */
function aMinuti(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function generaSlot() {
  const slot = [];
  for (let m = aMinuti(ORARIO_INIZIO); m <= aMinuti(ORARIO_FINE); m += SLOT_MINUTI) {
    slot.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return slot;
}

function oggiISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

function telefonoValido(v) {
  const s = String(v || '').trim();
  if (!/^[+]?[\d\s().\-/]{6,25}$/.test(s)) return false;
  const cifre = (s.match(/\d/g) || []).length;
  return cifre >= 7 && cifre <= 15;
}

async function verificaPassword(pwd) {
  if (!pwd) return false;
  const rows = await sql`SELECT password_hash FROM admin_credenziali WHERE id = 1`;
  if (!rows.length) return String(pwd) === ADMIN_PASSWORD;
  return bcrypt.compare(String(pwd), rows[0].password_hash);
}

async function authOk(req) {
  const pwd = req.body?.password !== undefined ? req.body.password : req.query.password;
  return verificaPassword(pwd);
}

const STATI_ATTIVI = ['attesa', 'confermata'];

/* ============================================================
 *  DATABASE — PIATTI
 * ========================================================== */
function normalizzaPiatto(r) {
  const stato = ['visibile', 'nascosto', 'esaurito'].includes(r.stato) ? r.stato : 'visibile';
  let prezzo = (r.prezzo === '' || r.prezzo == null) ? null : Number(r.prezzo);
  if (!Number.isFinite(prezzo)) prezzo = null;
  return {
    id:          Number(r.id),
    nome:        String(r.nome || '').trim(),
    descrizione: String(r.descrizione || '').trim(),
    prezzo,
    stato
  };
}

function validaPiatto(p) {
  if (!p || typeof p !== 'object') return 'dati non validi';
  const nome = String(p.nome || '').trim();
  if (nome.length < 2)   return 'Il nome del piatto è obbligatorio (minimo 2 caratteri).';
  if (nome.length > 80)  return 'Il nome è troppo lungo (max 80 caratteri).';
  const desc = String(p.descrizione || '').trim();
  if (desc.length > 200) return 'La descrizione è troppo lunga (max 200 caratteri).';
  if (p.prezzo !== undefined && p.prezzo !== null && p.prezzo !== '') {
    const pr = Number(p.prezzo);
    if (!Number.isFinite(pr) || pr < 0 || pr > 999) return 'Prezzo non valido.';
  }
  if (p.stato !== undefined && !['visibile', 'nascosto', 'esaurito'].includes(p.stato))
    return 'Stato non valido.';
  return null;
}

async function leggiPiatti() {
  const rows = await sql`SELECT id, nome, descrizione, prezzo, stato FROM piatti ORDER BY ordine, id`;
  return rows.map(r => normalizzaPiatto(r));
}

/* ============================================================
 *  DATABASE — PRENOTAZIONI
 * ========================================================== */
async function leggiPrenotazioni() {
  const rows = await sql`
    SELECT
      p.id,
      p.nome,
      p.telefono,
      p.persone,
      p.data::text   AS data,
      p.orario,
      p.note,
      p.origine,
      p.stato,
      p.stato_cucina,
      p.creata_il,
      COALESCE(
        json_agg(
          json_build_object('tipo', pp.tipo, 'nome', pp.nome)
          ORDER BY pp.ordine
        ) FILTER (WHERE pp.id IS NOT NULL),
        '[]'::json
      ) AS piatti
    FROM prenotazioni p
    LEFT JOIN prenotazione_piatti pp ON pp.prenotazione_id = p.id
    GROUP BY p.id, p.nome, p.telefono, p.persone, p.data, p.orario,
             p.note, p.origine, p.stato, p.stato_cucina, p.creata_il
    ORDER BY p.creata_il DESC
  `;
  return rows.map(r => ({
    id:          Number(r.id),
    nome:        r.nome,
    telefono:    r.telefono || '',
    persone:     Number(r.persone),
    data:        String(r.data || ''),
    orario:      r.orario,
    piatti:      Array.isArray(r.piatti) ? r.piatti : [],
    note:        r.note || '',
    origine:     r.origine  || 'online',
    stato:       r.stato    || 'attesa',
    statoCucina: r.stato_cucina || 'nuova',
    creataIl:    r.creata_il instanceof Date
                   ? r.creata_il.toISOString()
                   : String(r.creata_il || '')
  }));
}

async function salvaPrenotazione(p) {
  await sql`
    INSERT INTO prenotazioni
      (id, nome, telefono, persone, data, orario, note, origine, stato, stato_cucina, creata_il)
    VALUES
      (${p.id}, ${p.nome}, ${p.telefono}, ${p.persone},
       ${p.data}::date, ${p.orario}, ${p.note},
       ${p.origine}, ${p.stato}, ${p.statoCucina},
       ${p.creataIl}::timestamptz)
  `;
  const piattiArr = p.piatti || [];
  for (let i = 0; i < piattiArr.length; i++) {
    const pi = piattiArr[i];
    await sql`
      INSERT INTO prenotazione_piatti (prenotazione_id, tipo, nome, ordine)
      VALUES (${p.id}, ${pi.tipo}, ${pi.nome}, ${i})
    `;
  }
}

function copertiSlot(prenotazioni, data, orario, escludiId = null) {
  return prenotazioni
    .filter(p =>
      p.data === data &&
      p.orario === orario &&
      STATI_ATTIVI.includes(p.stato || 'attesa') &&
      String(p.id) !== String(escludiId))
    .reduce((s, p) => s + (Number(p.persone) || 0), 0);
}

function disponibilitaGiorno(prenotazioni, data) {
  return generaSlot().map(orario => {
    const occupati = copertiSlot(prenotazioni, data, orario);
    return { orario, occupati, liberi: Math.max(0, POSTI_PER_SLOT - occupati) };
  });
}

function creaPrenotazione(d) {
  return {
    id:          Date.now() + Math.floor(Math.random() * 1000),
    nome:        String(d.nome).trim(),
    telefono:    String(d.telefono || '').trim(),
    persone:     Number(d.persone),
    data:        d.data,
    orario:      d.orario,
    piatti:      (d.piatti || []).map(p => ({
      tipo: p.tipo === 'carta' ? 'carta' : 'giorno',
      nome: String(p.nome).trim()
    })),
    note:        d.note ? String(d.note).trim() : '',
    origine:     ['online', 'telefonica', 'walkin', 'manuale'].includes(d.origine) ? d.origine : 'online',
    stato:       ['attesa', 'confermata', 'rifiutata', 'completata'].includes(d.stato) ? d.stato : 'attesa',
    statoCucina: ['nuova', 'in_preparazione', 'pronta', 'consegnata'].includes(d.statoCucina)
                   ? d.statoCucina : 'nuova',
    creataIl:    new Date().toISOString()
  };
}

/* ============================================================
 *  NOTIFICHE TELEGRAM
 * ========================================================== */
function etichettaOrigine(o) {
  return ({ online: 'Online', telefonica: 'Telefonica', walkin: 'Walk-in', manuale: 'Manuale' })[o] || 'Online';
}

function escTg(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function costruisciTelegramNotificaTitolare(p, statoFinale = null) {
  const piattiBlock = (p.piatti && p.piatti.length)
    ? p.piatti.map(d =>
        `   • <i>${escTg(d.tipo === 'carta' ? 'Drink List' : 'Menu del Giorno')}</i> — ${escTg(d.nome)}`
      ).join('\n')
    : '   <i>Nessuna pietanza selezionata</i>';
  const telefonoRiga = p.telefono ? `📞 <b>Telefono:</b> ${escTg(p.telefono)}` : '📞 <b>Telefono:</b> —';
  const noteRiga     = p.note     ? `\n📝 <b>Note:</b> <i>${escTg(p.note)}</i>` : '';
  const statoRiga    = statoFinale === 'confermata' ? '✅ <b>CONFERMATA</b>'
                     : statoFinale === 'rifiutata'  ? '❌ <b>RIFIUTATA</b>'
                     : '⏳ <i>In attesa di conferma</i>';
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
    statoRiga
  ].join('\n');
}

function linkMessaggioCliente(p, testo) {
  const tel = String(p.telefono || '').replace(/[^\d]/g, '');
  if (!tel) return null;
  const numero = tel.length === 10 && tel.startsWith('3') ? '39' + tel : tel;
  return `https://wa.me/${numero}?text=${encodeURIComponent(testo)}`;
}

async function inviaTelegram(testoHtml, replyMarkup = null) {
  if (!TELEGRAM_ATTIVO) {
    console.log('[notifiche][SIMULAZIONE] Telegram non configurato.');
    console.log('--- messaggio ---\n' + testoHtml.replace(/<\/?[^>]+>/g, '') + '\n-----------------');
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  let almenoUno = false;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const msgBody = {
        chat_id:                  chatId,
        text:                     testoHtml,
        parse_mode:               'HTML',
        disable_web_page_preview: true
      };
      if (replyMarkup) msgBody.reply_markup = replyMarkup;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody)
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        console.error(`[notifiche] ERRORE Telegram chat ${chatId}:`, data.description || resp.statusText);
      } else {
        console.log(`[notifiche] Telegram inviato a ${chatId} — message_id:`, data.result.message_id);
        almenoUno = true;
      }
    } catch (err) {
      console.error(`[notifiche] ERRORE rete Telegram chat ${chatId}:`, err?.message || err);
    }
  }
  return almenoUno;
}

async function notificaTitolare(prenotazione) {
  if (giàNotificata(prenotazione.id)) {
    console.log('[notifiche] Già notificato id', prenotazione.id, '— saltato (anti-duplicato).');
    return false;
  }
  const testo = costruisciTelegramNotificaTitolare(prenotazione);
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Conferma', callback_data: `conferma:${prenotazione.id}` },
      { text: '❌ Rifiuta',  callback_data: `rifiuta:${prenotazione.id}`  }
    ]]
  };
  return inviaTelegram(testo, replyMarkup);
}

/* ============================================================
 *  SMS (Twilio REST API — no SDK)
 * ========================================================== */
function normalizzaTelefono(raw) {
  const s = String(raw || '').replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) return s;
  if (s.startsWith('0039')) return '+' + s.slice(2);
  if (s.startsWith('39') && s.length >= 11) return '+' + s;
  return '+39' + s;
}

async function inviaSMS(numeroDest, testo) {
  const numero = normalizzaTelefono(numeroDest);
  if (!TWILIO_ATTIVO) {
    console.log(`[sms][SIMULAZIONE] SMS a ${numero}:\n${testo}`);
    return false;
  }
  try {
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const body = new URLSearchParams({ To: numero, From: TWILIO_FROM_NUMBER, Body: testo });
    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await resp.json();
    if (!resp.ok || data.status === 'failed') {
      console.error('[sms] ERRORE Twilio:', data.message || resp.statusText);
      return false;
    }
    console.log('[sms] Inviato a', numero, '— SID:', data.sid);
    return true;
  } catch (err) {
    console.error('[sms] ERRORE rete:', err?.message || err);
    return false;
  }
}

function costruisciSMSConferma(pren) {
  return [
    `✅ Bistrout & Café Mozart`,
    `👤 ${pren.nome} · 👥 ${pren.persone}p · 📅 ${pren.data} · 🕐 ${pren.orario}`,
    `Prenotazione confermata / Reservation confirmed 🎉`
  ].join('\n');
}

function costruisciSMSRifiuto(pren, alternativi = []) {
  const alt = alternativi.length ? `⏰ ${alternativi.join(' / ')}` : '';
  return [
    `❌ Bistrout & Café Mozart`,
    `👤 ${pren.nome} · 📅 ${pren.data} · 🕐 ${pren.orario}`,
    `Non disponibile / Not available`,
    alt,
    `📞 +39 3334867216`
  ].filter(Boolean).join('\n');
}

/* ============================================================
 *  API PUBBLICHE
 * ========================================================== */

/* Health check — stato del server e della connessione DB */
app.get('/api/health', async (req, res) => {
  const dbSet = (process.env.DATABASE_URL || '').length > 10;
  let dbOk = false;
  let dbError = null;
  if (dbSet) {
    try {
      await sql`SELECT 1`;
      dbOk = true;
    } catch (e) {
      dbError = e.message;
    }
  }
  res.json({ ok: dbOk, db_set: dbSet, db_ok: dbOk, db_err: dbError });
});

/* Configurazione per il form di prenotazione */
app.get('/api/config', (req, res) => {
  res.json({
    orarioInizio: ORARIO_INIZIO,
    orarioFine:   ORARIO_FINE,
    slot:         generaSlot(),
    oggi:         oggiISO(),
    postiPerSlot: POSTI_PER_SLOT
  });
});

/* Disponibilità per fascia oraria di un dato giorno (default: oggi) */
app.get('/api/disponibilita', async (req, res) => {
  try {
    const data = req.query.data || oggiISO();
    const prenotazioni = await leggiPrenotazioni();
    res.json({ data, postiPerSlot: POSTI_PER_SLOT, slot: disponibilitaGiorno(prenotazioni, data) });
  } catch (err) {
    console.error('[/api/disponibilita]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Menu del Giorno — solo i piatti mostrabili al pubblico (visibili o esauriti) */
app.get('/api/piatti', async (req, res) => {
  try {
    const tutti    = await leggiPiatti();
    const pubblici = tutti
      .filter(p => p.stato !== 'nascosto')
      .map(({ nome, descrizione, prezzo, stato }) => ({ nome, descrizione, prezzo, stato }));
    res.json({ piatti: pubblici });
  } catch (err) {
    console.error('[/api/piatti]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Disponibilità menu PDF */
app.get('/api/menu', async (req, res) => {
  try {
    const rows = await sql`SELECT id FROM menu_pdf WHERE id = 1`;
    res.json({ disponibile: rows.length > 0, url: '/menu.pdf' });
  } catch (err) {
    console.error('[/api/menu]', err);
    res.json({ disponibile: false, url: '/menu.pdf' });
  }
});

/* Visualizzazione menu PDF (inline, non download) */
app.get('/menu.pdf', async (req, res) => {
  try {
    const rows = await sql`SELECT data_base64 FROM menu_pdf WHERE id = 1`;
    if (!rows.length || !rows[0].data_base64)
      return res.status(404).send('Menu non disponibile.');
    const buf = Buffer.from(rows[0].data_base64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="menu.pdf"');
    res.send(buf);
  } catch (err) {
    console.error('[/menu.pdf]', err);
    res.status(500).send('Errore nel caricamento del menu.');
  }
});

/* POST /api/prenotazioni — prenotazione pubblica (solo oggi) */
app.post('/api/prenotazioni', async (req, res) => {
  try {
    const { nome, persone, data, orario, telefono, piatti, note } = req.body;
    const nPersone = Number(persone);

    if (!nome || String(nome).trim().length < 2)
      return res.status(400).json({ ok: false, codice: 'nome' });
    if (!telefonoValido(telefono))
      return res.status(400).json({ ok: false, codice: 'telefono' });
    if (!Number.isInteger(nPersone) || nPersone < 1)
      return res.status(400).json({ ok: false, codice: 'persone' });

    const oggi = oggiISO();
    if (!data || data !== oggi)
      return res.status(400).json({ ok: false, codice: 'data' });
    if (!orario || !generaSlot().includes(orario))
      return res.status(400).json({ ok: false, codice: 'orario' });

    const sceltePiatti = Array.isArray(piatti) ? piatti.filter(p => p && p.nome) : [];
    const prenotazioni  = await leggiPrenotazioni();
    const occupati      = copertiSlot(prenotazioni, data, orario);
    const liberi        = Math.max(0, POSTI_PER_SLOT - occupati);

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
    await salvaPrenotazione(nuova);

    let notificaInviata = false;
    try { notificaInviata = await notificaTitolare(nuova); }
    catch (e) { console.error('[notifiche] Errore imprevisto:', e); }

    res.json({ ok: true, codice: 'ok', prenotazione: nuova, notificaInviata });
  } catch (err) {
    console.error('[POST /api/prenotazioni]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* ============================================================
 *  WEBHOOK TELEGRAM (callback bottoni Conferma / Rifiuta)
 * ========================================================== */
app.post('/api/telegram/webhook', async (req, res) => {
  res.json({ ok: true }); // Risponde subito a Telegram (< 5 s)

  const update = req.body;
  if (!update?.callback_query) return;

  const cb     = update.callback_query;
  const parts  = (cb.data || '').split(':');
  const azione = parts[0];
  const id     = Number(parts[1]);

  if (!['conferma', 'rifiuta'].includes(azione) || !id) return;

  const nuovoStato = azione === 'conferma' ? 'confermata' : 'rifiutata';

  // Rimuove il "loading" dal bottone
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: cb.id,
      text: nuovoStato === 'confermata' ? '✅ Prenotazione confermata!' : '❌ Prenotazione rifiutata.'
    })
  }).catch(() => {});

  try {
    const rows = await sql`UPDATE prenotazioni SET stato=${nuovoStato} WHERE id=${id} RETURNING id`;
    if (!rows.length) return;

    const lista = await leggiPrenotazioni();
    const pren  = lista.find(p => String(p.id) === String(id));
    if (!pren) return;

    // Modifica il messaggio nella chat di chi ha cliccato (rimuove i bottoni, aggiunge stato)
    const testoAggiornato = costruisciTelegramNotificaTitolare(pren, nuovoStato);
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:                  cb.message.chat.id,
        message_id:               cb.message.message_id,
        text:                     testoAggiornato,
        parse_mode:               'HTML',
        disable_web_page_preview: true
      })
    }).catch(() => {});

    // Invia SMS al cliente
    if (pren.telefono) {
      if (nuovoStato === 'confermata') {
        await inviaSMS(pren.telefono, costruisciSMSConferma(pren));
      } else {
        const alternativi = disponibilitaGiorno(lista, pren.data)
          .filter(s => s.liberi >= pren.persone).map(s => s.orario);
        await inviaSMS(pren.telefono, costruisciSMSRifiuto(pren, alternativi));
      }
    }
  } catch (err) {
    console.error('[telegram/webhook] Errore:', err);
  }
});

/* ============================================================
 *  API ADMIN (protette da password)
 * ========================================================== */

app.post('/api/admin/login', async (req, res) => {
  if (await verificaPassword(req.body.password)) return res.json({ ok: true });
  res.status(401).json({ ok: false, messaggio: 'Password errata.' });
});

/* Registra il webhook Telegram — chiamare UNA VOLTA dopo ogni deploy su Vercel:
 *   GET /api/admin/telegram/setup-webhook?password=<pwd>
 */
app.get('/api/admin/telegram/setup-webhook', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  if (!TELEGRAM_ATTIVO) return res.status(400).json({ ok: false, messaggio: 'Telegram non configurato (credenziali mancanti).' });

  const host       = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const protocol   = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  const webhookUrl = `${protocol}://${host}/api/telegram/webhook`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await resp.json();
    if (data.ok) {
      res.json({ ok: true, messaggio: `Webhook registrato: ${webhookUrl}` });
    } else {
      res.status(500).json({ ok: false, messaggio: data.description });
    }
  } catch (err) {
    res.status(500).json({ ok: false, messaggio: err.message });
  }
});

/* Cambia password admin */
app.post('/api/admin/password', async (req, res) => {
  const { password, nuova, conferma } = req.body;
  if (!(await verificaPassword(password)))
    return res.status(401).json({ ok: false, messaggio: 'Password attuale errata.' });
  if (!nuova || String(nuova).length < 6)
    return res.status(400).json({ ok: false, messaggio: 'La nuova password deve avere almeno 6 caratteri.' });
  if (nuova !== conferma)
    return res.status(400).json({ ok: false, messaggio: 'Le due password non coincidono.' });
  try {
    const hash = await bcrypt.hash(String(nuova), 10);
    await sql`
      INSERT INTO admin_credenziali (id, password_hash, aggiornato_il) VALUES (1, ${hash}, NOW())
      ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, aggiornato_il = NOW()
    `;
    res.json({ ok: true, messaggio: 'Password aggiornata.' });
  } catch (err) {
    console.error('[POST /api/admin/password]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' });
  }
});

/* ── Gestione Menu del Giorno ─────────────────────────────── */

app.get('/api/admin/piatti', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  try {
    res.json({ ok: true, piatti: await leggiPiatti() });
  } catch (err) {
    console.error('[GET /api/admin/piatti]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

app.post('/api/admin/piatti/aggiungi', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const errore = validaPiatto(req.body.piatto);
  if (errore) return res.status(400).json({ ok: false, messaggio: errore });
  try {
    const p           = req.body.piatto;
    const nome        = String(p.nome || '').trim();
    const descrizione = String(p.descrizione || '').trim();
    const prezzo      = (p.prezzo === '' || p.prezzo == null) ? null : Number(p.prezzo);
    const stato       = ['visibile', 'nascosto', 'esaurito'].includes(p.stato) ? p.stato : 'visibile';
    const maxRow      = await sql`SELECT COALESCE(MAX(ordine), -1) AS mx FROM piatti`;
    const ordine      = Number(maxRow[0].mx) + 1;
    await sql`
      INSERT INTO piatti (nome, descrizione, prezzo, stato, ordine)
      VALUES (${nome}, ${descrizione}, ${prezzo}, ${stato}, ${ordine})
    `;
    res.json({ ok: true, messaggio: 'Piatto aggiunto.', piatti: await leggiPiatti() });
  } catch (err) {
    console.error('[POST /api/admin/piatti/aggiungi]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' });
  }
});

app.post('/api/admin/piatti/modifica', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const id     = Number(req.body.id);
  const errore = validaPiatto(req.body.piatto);
  if (errore) return res.status(400).json({ ok: false, messaggio: errore });
  try {
    const p      = req.body.piatto;
    const nome   = String(p.nome || '').trim();
    const desc   = String(p.descrizione || '').trim();
    const prezzo = (p.prezzo === '' || p.prezzo == null) ? null : Number(p.prezzo);
    const rows   = await sql`SELECT stato FROM piatti WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    const stato = (p.stato && ['visibile', 'nascosto', 'esaurito'].includes(p.stato))
                    ? p.stato : rows[0].stato;
    await sql`UPDATE piatti SET nome=${nome}, descrizione=${desc}, prezzo=${prezzo}, stato=${stato} WHERE id=${id}`;
    res.json({ ok: true, messaggio: 'Piatto aggiornato.', piatti: await leggiPiatti() });
  } catch (err) {
    console.error('[POST /api/admin/piatti/modifica]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' });
  }
});

/* Cambia solo lo stato (visibile / nascosto / esaurito) */
app.post('/api/admin/piatti/stato', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const id    = Number(req.body.id);
  const stato = req.body.stato;
  if (!['visibile', 'nascosto', 'esaurito'].includes(stato))
    return res.status(400).json({ ok: false, messaggio: 'Stato non valido.' });
  try {
    const rows = await sql`UPDATE piatti SET stato=${stato} WHERE id=${id} RETURNING id`;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    res.json({ ok: true, messaggio: 'Stato aggiornato.', piatti: await leggiPiatti() });
  } catch (err) {
    console.error('[POST /api/admin/piatti/stato]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' });
  }
});

app.post('/api/admin/piatti/elimina', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const id = Number(req.body.id);
  try {
    const rows = await sql`DELETE FROM piatti WHERE id=${id} RETURNING id`;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Piatto non trovato.' });
    res.json({ ok: true, messaggio: 'Piatto eliminato.', piatti: await leggiPiatti() });
  } catch (err) {
    console.error('[POST /api/admin/piatti/elimina]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio.' });
  }
});

/* Upload menu PDF — salvato come base64 nel DB (compatibile serverless) */
app.post('/api/admin/menu', uploadPdf.single('file'), async (req, res) => {
  if (!(await verificaPassword(req.body.password)))
    return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  if (!req.file)
    return res.status(400).json({ ok: false, messaggio: 'Nessun file caricato.' });
  try {
    const base64 = req.file.buffer.toString('base64');
    await sql`
      INSERT INTO menu_pdf (id, data_base64, aggiornato_il) VALUES (1, ${base64}, NOW())
      ON CONFLICT (id) DO UPDATE SET data_base64 = EXCLUDED.data_base64, aggiornato_il = NOW()
    `;
    res.json({ ok: true, messaggio: 'Menu PDF aggiornato con successo.' });
  } catch (err) {
    console.error('[POST /api/admin/menu]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore nel salvataggio del menu.' });
  }
});

/* ── Gestione prenotazioni (admin) ───────────────────────── */

/* Elenco prenotazioni + config + disponibilità del giorno richiesto */
app.get('/api/admin/prenotazioni', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  try {
    const data         = req.query.data || oggiISO();
    const prenotazioni = await leggiPrenotazioni();
    res.json({
      ok:           true,
      prenotazioni,
      config:       { postiPerSlot: POSTI_PER_SLOT, slot: generaSlot(), oggi: oggiISO() },
      disponibilita: disponibilitaGiorno(prenotazioni, data)
    });
  } catch (err) {
    console.error('[GET /api/admin/prenotazioni]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Crea prenotazione manuale / telefonica / walk-in (lato admin) */
app.post('/api/admin/prenotazioni/crea', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { nome, telefono, persone, data, orario, piatti, note, origine, stato } = req.body;
  const nPersone = Number(persone);

  if (!nome || String(nome).trim().length < 2)
    return res.status(400).json({ ok: false, messaggio: 'Nome non valido.' });
  if (!Number.isInteger(nPersone) || nPersone < 1)
    return res.status(400).json({ ok: false, messaggio: 'Numero persone non valido.' });
  if (!data) return res.status(400).json({ ok: false, messaggio: 'Data mancante.' });
  if (!orario || !generaSlot().includes(orario))
    return res.status(400).json({ ok: false, messaggio: 'Orario non valido.' });
  if (telefono && !telefonoValido(telefono))
    return res.status(400).json({ ok: false, messaggio: 'Telefono non valido.' });

  try {
    const prenotazioni = await leggiPrenotazioni();
    const occupati     = copertiSlot(prenotazioni, data, orario);
    const liberi       = Math.max(0, POSTI_PER_SLOT - occupati);
    if (nPersone > liberi && !req.body.forza) {
      return res.status(409).json({
        ok: false, codice: 'pieno', liberi,
        messaggio: `Solo ${liberi} posti liberi in quella fascia. Conferma per forzare l'overbooking.`
      });
    }
    const nuova = creaPrenotazione({
      nome, telefono, persone: nPersone, data, orario,
      piatti: Array.isArray(piatti) ? piatti : [],
      note,
      origine: origine || 'manuale',
      stato:   stato   || 'confermata'
    });
    await salvaPrenotazione(nuova);
    res.json({ ok: true, prenotazione: nuova });
  } catch (err) {
    console.error('[POST /api/admin/prenotazioni/crea]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Modifica una prenotazione esistente (admin) */
app.post('/api/admin/prenotazioni/modifica', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, nome, telefono, persone, data, orario, note } = req.body;
  const nPersone = Number(persone);

  if (!nome || String(nome).trim().length < 2)
    return res.status(400).json({ ok: false, messaggio: 'Nome non valido.' });
  if (!Number.isInteger(nPersone) || nPersone < 1)
    return res.status(400).json({ ok: false, messaggio: 'Numero persone non valido.' });
  if (!orario || !generaSlot().includes(orario))
    return res.status(400).json({ ok: false, messaggio: 'Orario non valido.' });
  if (telefono && !telefonoValido(telefono))
    return res.status(400).json({ ok: false, messaggio: 'Telefono non valido.' });

  try {
    const lista = await leggiPrenotazioni();
    const pren  = lista.find(p => String(p.id) === String(id));
    if (!pren) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });

    const dataFinale = data || pren.data;
    const occupati   = copertiSlot(lista, dataFinale, orario, pren.id);
    const liberi     = Math.max(0, POSTI_PER_SLOT - occupati);
    if (nPersone > liberi && !req.body.forza)
      return res.status(409).json({
        ok: false, codice: 'pieno', liberi,
        messaggio: `Solo ${liberi} posti liberi in quella fascia.`
      });

    await sql`
      UPDATE prenotazioni
      SET nome     = ${String(nome).trim()},
          telefono = ${String(telefono || '').trim()},
          persone  = ${nPersone},
          data     = ${dataFinale}::date,
          orario   = ${orario},
          note     = ${note ? String(note).trim() : ''}
      WHERE id = ${Number(id)}
    `;
    const aggiornata = {
      ...pren,
      nome:     String(nome).trim(),
      telefono: String(telefono || '').trim(),
      persone:  nPersone,
      data:     dataFinale,
      orario,
      note:     note ? String(note).trim() : ''
    };
    res.json({ ok: true, prenotazione: aggiornata });
  } catch (err) {
    console.error('[POST /api/admin/prenotazioni/modifica]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Cambia stato: attesa / confermata / rifiutata / completata */
app.post('/api/admin/prenotazioni/stato', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, stato } = req.body;
  if (!['attesa', 'confermata', 'rifiutata', 'completata'].includes(stato))
    return res.status(400).json({ ok: false, messaggio: 'Stato non valido.' });

  try {
    const rows = await sql`UPDATE prenotazioni SET stato=${stato} WHERE id=${Number(id)} RETURNING id`;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });

    const lista = await leggiPrenotazioni();
    const pren  = lista.find(p => String(p.id) === String(id));

    let linkCliente = null;
    let smsInviato  = false;
    if (pren?.telefono) {
      if (stato === 'confermata') {
        smsInviato  = await inviaSMS(pren.telefono, costruisciSMSConferma(pren));
        linkCliente = linkMessaggioCliente(pren, costruisciSMSConferma(pren));
      } else if (stato === 'rifiutata') {
        const alternativi = disponibilitaGiorno(lista, pren.data)
          .filter(s => s.liberi >= pren.persone).map(s => s.orario);
        smsInviato  = await inviaSMS(pren.telefono, costruisciSMSRifiuto(pren, alternativi));
        linkCliente = linkMessaggioCliente(pren, costruisciSMSRifiuto(pren, alternativi));
      }
    }
    res.json({ ok: true, prenotazione: pren || { id: Number(id), stato }, linkCliente, smsInviato });
  } catch (err) {
    console.error('[POST /api/admin/prenotazioni/stato]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Cambia lo STATO CUCINA (Kitchen Display) */
app.post('/api/admin/prenotazioni/stato-cucina', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id, statoCucina } = req.body;
  if (!['nuova', 'in_preparazione', 'pronta', 'consegnata'].includes(statoCucina))
    return res.status(400).json({ ok: false, messaggio: 'Stato cucina non valido.' });

  try {
    const rows = await sql`
      UPDATE prenotazioni SET stato_cucina=${statoCucina} WHERE id=${Number(id)} RETURNING id
    `;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });
    const lista = await leggiPrenotazioni();
    const pren  = lista.find(p => String(p.id) === String(id));
    res.json({ ok: true, prenotazione: pren || { id: Number(id), statoCucina } });
  } catch (err) {
    console.error('[POST /api/admin/prenotazioni/stato-cucina]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* Elimina una prenotazione */
app.post('/api/admin/prenotazioni/elimina', async (req, res) => {
  if (!(await authOk(req))) return res.status(401).json({ ok: false, messaggio: 'Password errata.' });
  const { id } = req.body;
  try {
    const rows = await sql`DELETE FROM prenotazioni WHERE id=${Number(id)} RETURNING id`;
    if (!rows.length) return res.status(404).json({ ok: false, messaggio: 'Prenotazione non trovata.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/admin/prenotazioni/elimina]', err);
    res.status(500).json({ ok: false, messaggio: 'Errore server.' });
  }
});

/* ============================================================
 *  AVVIO SERVER (locale) — su Vercel l'export è sufficiente
 * ========================================================== */
if (process.env.NODE_ENV !== 'production' || process.env.PORT) {
  app.listen(PORT, () => {
    console.log(`\n  Bistrout & Café Mozart è online!`);
    console.log(`  Sito:         http://localhost:${PORT}`);
    console.log(`  Admin:        http://localhost:${PORT}/admin.html`);
    console.log(`  Prenotazioni: http://localhost:${PORT}/prenotazioni.html\n`);
  });
}

module.exports = app;
