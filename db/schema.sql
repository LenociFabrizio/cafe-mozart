-- ============================================================
--  Bistrout & Café Mozart — Schema PostgreSQL (Neon)
--  Esegui questo file UNA VOLTA sul tuo database Neon prima
--  del primo deploy, oppure usa db/seed.js per farlo in automatico.
-- ============================================================

-- Piatti del Menu del Giorno
CREATE TABLE IF NOT EXISTS piatti (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(80)    NOT NULL,
  descrizione VARCHAR(200)   NOT NULL DEFAULT '',
  prezzo      NUMERIC(6,2),
  stato       VARCHAR(20)    NOT NULL DEFAULT 'visibile',
  ordine      INT            NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT piatti_stato_check CHECK (stato IN ('visibile','nascosto','esaurito'))
);

-- Prenotazioni (tavoli / coperti)
CREATE TABLE IF NOT EXISTS prenotazioni (
  id          BIGINT         PRIMARY KEY,
  nome        VARCHAR(100)   NOT NULL,
  telefono    VARCHAR(30)    NOT NULL DEFAULT '',
  persone     INT            NOT NULL,
  data        DATE           NOT NULL,
  orario      VARCHAR(5)     NOT NULL,
  note        TEXT           NOT NULL DEFAULT '',
  origine     VARCHAR(20)    NOT NULL DEFAULT 'online',
  stato       VARCHAR(20)    NOT NULL DEFAULT 'attesa',
  stato_cucina VARCHAR(20)   NOT NULL DEFAULT 'nuova',
  creata_il   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT prenotazioni_stato_check       CHECK (stato       IN ('attesa','confermata','rifiutata','completata')),
  CONSTRAINT prenotazioni_stato_cucina_check CHECK (stato_cucina IN ('nuova','in_preparazione','pronta','consegnata')),
  CONSTRAINT prenotazioni_origine_check     CHECK (origine     IN ('online','telefonica','walkin','manuale'))
);

-- Pietanze associate a ogni prenotazione (relazione 1-N)
CREATE TABLE IF NOT EXISTS prenotazione_piatti (
  id              SERIAL  PRIMARY KEY,
  prenotazione_id BIGINT  NOT NULL REFERENCES prenotazioni(id) ON DELETE CASCADE,
  tipo            VARCHAR(20) NOT NULL DEFAULT 'giorno',
  nome            VARCHAR(80) NOT NULL,
  ordine          INT     NOT NULL DEFAULT 0,
  CONSTRAINT pren_piatti_tipo_check CHECK (tipo IN ('giorno','carta'))
);

-- Menu PDF (un solo record: id = 1)
-- Il PDF è memorizzato come testo base64 per compatibilità serverless
CREATE TABLE IF NOT EXISTS menu_pdf (
  id            INT         PRIMARY KEY DEFAULT 1,
  data_base64   TEXT,
  aggiornato_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indici per le query più comuni
CREATE INDEX IF NOT EXISTS idx_prenotazioni_data       ON prenotazioni(data);
CREATE INDEX IF NOT EXISTS idx_prenotazioni_stato      ON prenotazioni(stato);
CREATE INDEX IF NOT EXISTS idx_prenotazioni_creata_il  ON prenotazioni(creata_il DESC);
CREATE INDEX IF NOT EXISTS idx_pren_piatti_id          ON prenotazione_piatti(prenotazione_id);
CREATE INDEX IF NOT EXISTS idx_piatti_ordine           ON piatti(ordine, id);
