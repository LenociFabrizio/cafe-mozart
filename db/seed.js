#!/usr/bin/env node
/**
 * db/seed.js — Crea le tabelle e migra i dati locali su Neon
 *
 * Uso:
 *   npm run seed
 *   (oppure: node db/seed.js)
 *
 * Prerequisiti:
 *   - DATABASE_URL impostato nel .env (o come variabile d'ambiente)
 *   - npm install (per avere @neondatabase/serverless)
 *
 * Note:
 *   - Può essere eseguito più volte: usa IF NOT EXISTS e salta i dati
 *     già presenti, quindi è sicuro ri-eseguirlo.
 */
require('dotenv').config({ quiet: true });

const { neon } = require('@neondatabase/serverless');
const fs   = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('\n[seed] ERRORE: variabile DATABASE_URL non trovata.');
  console.error('       Crea il file .env con DATABASE_URL=postgresql://...\n');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

async function creaSchema() {
  console.log('[seed] Creazione tabelle...');

  await sql`
    CREATE TABLE IF NOT EXISTS piatti (
      id          SERIAL PRIMARY KEY,
      nome        VARCHAR(80)    NOT NULL,
      descrizione VARCHAR(200)   NOT NULL DEFAULT '',
      prezzo      NUMERIC(6,2),
      stato       VARCHAR(20)    NOT NULL DEFAULT 'visibile',
      ordine      INT            NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
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

  await sql`CREATE INDEX IF NOT EXISTS idx_prenotazioni_data      ON prenotazioni(data)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_prenotazioni_stato     ON prenotazioni(stato)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_prenotazioni_creata_il ON prenotazioni(creata_il DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pren_piatti_id         ON prenotazione_piatti(prenotazione_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_piatti_ordine          ON piatti(ordine, id)`;

  console.log('[seed] Schema creato / verificato.');
}

async function seedPiatti() {
  const piattiFile = path.join(__dirname, '..', 'data', 'piatti.json');
  if (!fs.existsSync(piattiFile)) {
    console.log('[seed] File piatti.json non trovato — skip.');
    return;
  }
  const existing = await sql`SELECT COUNT(*) AS n FROM piatti`;
  if (Number(existing[0].n) > 0) {
    console.log('[seed] Tabella piatti già popolata — skip.');
    return;
  }
  const piatti = JSON.parse(fs.readFileSync(piattiFile, 'utf8'));
  console.log(`[seed] Inserisco ${piatti.length} piatti...`);
  for (let i = 0; i < piatti.length; i++) {
    const p           = piatti[i];
    const nome        = String(p.nome || '').trim();
    const descrizione = String(p.descrizione || '').trim();
    const prezzo      = (p.prezzo === '' || p.prezzo == null) ? null : Number(p.prezzo);
    const stato       = ['visibile', 'nascosto', 'esaurito'].includes(p.stato) ? p.stato : 'visibile';
    await sql`
      INSERT INTO piatti (nome, descrizione, prezzo, stato, ordine)
      VALUES (${nome}, ${descrizione}, ${prezzo}, ${stato}, ${i})
    `;
  }
  console.log('[seed] Piatti migrati.');
}

async function seedPrenotazioni() {
  const prenFile = path.join(__dirname, '..', 'data', 'prenotazioni.json');
  if (!fs.existsSync(prenFile)) {
    console.log('[seed] File prenotazioni.json non trovato — skip.');
    return;
  }
  const existing = await sql`SELECT COUNT(*) AS n FROM prenotazioni`;
  if (Number(existing[0].n) > 0) {
    console.log('[seed] Tabella prenotazioni già popolata — skip.');
    return;
  }
  const prenotazioni = JSON.parse(fs.readFileSync(prenFile, 'utf8'));
  console.log(`[seed] Inserisco ${prenotazioni.length} prenotazioni...`);
  for (const p of prenotazioni) {
    const stato       = ['attesa','confermata','rifiutata','completata'].includes(p.stato)       ? p.stato       : 'attesa';
    const statoCucina = ['nuova','in_preparazione','pronta','consegnata'].includes(p.statoCucina) ? p.statoCucina : 'nuova';
    const origine     = ['online','telefonica','walkin','manuale'].includes(p.origine)            ? p.origine     : 'online';
    const creataIl    = p.creataIl || new Date().toISOString();
    await sql`
      INSERT INTO prenotazioni
        (id, nome, telefono, persone, data, orario, note, origine, stato, stato_cucina, creata_il)
      VALUES (
        ${Number(p.id)}, ${String(p.nome||'').trim()}, ${String(p.telefono||'').trim()},
        ${Number(p.persone)}, ${p.data}::date, ${p.orario},
        ${String(p.note||'').trim()}, ${origine}, ${stato}, ${statoCucina},
        ${creataIl}::timestamptz
      )
    `;
    const piattiPren = Array.isArray(p.piatti) ? p.piatti : [];
    for (let i = 0; i < piattiPren.length; i++) {
      const pp   = piattiPren[i];
      const tipo = pp.tipo === 'carta' ? 'carta' : 'giorno';
      await sql`
        INSERT INTO prenotazione_piatti (prenotazione_id, tipo, nome, ordine)
        VALUES (${Number(p.id)}, ${tipo}, ${String(pp.nome||'').trim()}, ${i})
      `;
    }
  }
  console.log('[seed] Prenotazioni migrate.');
}

async function seedPdf() {
  const pdfFile = path.join(__dirname, '..', 'data', 'menu.pdf');
  if (!fs.existsSync(pdfFile)) {
    console.log('[seed] File menu.pdf non trovato — skip.');
    return;
  }
  const existing = await sql`SELECT COUNT(*) AS n FROM menu_pdf`;
  if (Number(existing[0].n) > 0) {
    console.log('[seed] PDF già presente nel DB — skip.');
    return;
  }
  console.log('[seed] Migro il PDF del menu...');
  const base64 = fs.readFileSync(pdfFile).toString('base64');
  await sql`INSERT INTO menu_pdf (id, data_base64, aggiornato_il) VALUES (1, ${base64}, NOW())`;
  console.log('[seed] PDF migrato.');
}

async function main() {
  console.log('\n[seed] Connessione a Neon...');
  try {
    await creaSchema();
    await seedPiatti();
    await seedPrenotazioni();
    await seedPdf();
    console.log('\n[seed] ✓ Migrazione completata con successo!\n');
  } catch (err) {
    console.error('\n[seed] ERRORE:', err.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
