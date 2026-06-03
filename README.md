# Bistrout & Café Mozart — Sito Vetrina

Sito web vetrina moderno ed elegante (tema **oro & nero**) per il **Bistrout & Café Mozart**
di Bari: bistrot, brunch, colazioni salate, Menu del Giorno e pasticceria artigianale.
Con prenotazione tavoli (capienza per fascia oraria), area admin e gestione completa
delle prenotazioni.

---

## Struttura del progetto

```
caffe-mozart-bari/
├── server.js              # Backend Node.js + Express
├── package.json           # Dipendenze e script
├── data/
│   ├── piatti.json        # Menu del Giorno: { nome, descrizione, prezzo, stato }
│   ├── menu.pdf           # Drink List (PDF, caricato dall'admin)
│   └── prenotazioni.json  # Prenotazioni salvate (generato in automatico)
└── public/
    ├── index.html         # Pagina principale del sito
    ├── admin.html         # Area admin: Menu del Giorno + Drink List PDF
    ├── prenotazioni.html  # Dashboard prenotazioni e tavoli
    ├── css/style.css      # Stile condiviso
    └── js/
        ├── i18n.js        # Traduzioni (9 lingue)
        └── script.js      # Logica del sito pubblico
```

---

## Avvio

```bash
npm install
npm start
```

Poi apri:
- Sito: http://localhost:3000
- Admin (Menu del Giorno + Drink List): http://localhost:3000/admin.html
- Prenotazioni: http://localhost:3000/prenotazioni.html

Password admin predefinita: `mozart2024` (modificabile in `server.js`, costante `ADMIN_PASSWORD`).

---

## Funzionalità principali

### Sito pubblico
- **Posizionamento bistrot**: hero con badge (Colazioni Salate, Brunch, Menu del Giorno,
  Pasticceria Artigianale, Caffetteria), sezione premium dedicata alle **Colazioni Salate**.
- **Menu del Giorno** (12:00–14:30) con foto, descrizione, prezzo e stato (esaurito).
- **Drink List** in PDF, visualizzabile inline (non scaricabile).
- **9 lingue**: Italiano, Inglese, Francese, Spagnolo, Tedesco, Cinese, **Polacco,
  Russo, Portoghese**. Orari in formato 24h o AM/PM secondo la lingua.
- **Prenotazione tavolo** con pietanze **facoltative** (nessuna, una o più), disponibilità
  per fascia oraria mostrata in tempo reale.
- **GDPR**: cookie banner (solo cookie tecnici), informativa privacy completa, consenso
  obbligatorio. Validazione telefono internazionale (E.164).
- Buoni pasto **Edenred** e social (Instagram, TikTok) in evidenza.

### Capienza e prenotazioni
- **20 posti per ogni fascia oraria da 30 minuti**, con disponibilità indipendente per slot.
- Blocco automatico oltre la capienza; l'admin può forzare un overbooking consapevole.
- **Stati prenotazione**: In attesa → Confermata / Rifiutata → Completata.
- Alla conferma/rifiuto viene generato un **messaggio WhatsApp pronto** per il cliente
  (con orari alternativi in caso di rifiuto).

### Area admin
- **Menu del Giorno**: aggiunta/modifica/eliminazione diretta (nome, descrizione, prezzo),
  con stati **Visibile / Nascosto / Esaurito** (i nascosti restano salvati ma non compaiono).
- **Drink List**: caricamento del PDF.
- **Dashboard prenotazioni**: vista per fascia oraria, filtri per stato, creazione di
  prenotazioni **telefoniche / walk-in / manuali**, modifica delle prenotazioni esistenti.

---

## Note sulle notifiche

WhatsApp Business API, SMS (Twilio) ed email transazionali richiedono account a pagamento,
credenziali e un dominio pubblico HTTPS: non funzionano su localhost. Per questo il sistema
attuale, **gratuito e pronto all'uso**, genera:
1. una notifica al titolare con **link WhatsApp pre-compilato** contenente tutti i dati
   della prenotazione;
2. alla conferma/rifiuto, un **messaggio WhatsApp pronto da inviare al cliente**.

Nel backend la funzione `inviaNotifica()` è il punto di estensione dove collegare in futuro
un provider reale (WhatsApp API / Telegram / Twilio / SMTP) inserendo le credenziali.
