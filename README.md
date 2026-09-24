# AudioTranslate Professional v3

Webapp pensata per registrazioni di lezioni universitarie in inglese.

## Cosa cambia rispetto alla versione locale

- file lunghi elaborati a blocchi;
- separazione degli interlocutori;
- riconoscimento e filtro inglese / italiano;
- parti italiane escluse dalla trascrizione finale;
- traduzione italiana segmento per segmento;
- timestamp e SRT;
- file audio temporanei eliminati al termine;
- API key conservata solo nel backend.

## Struttura

I file nella cartella principale vanno su GitHub Pages.
La cartella `server/` va pubblicata su un servizio Docker/Node (es. Render, Railway, Fly.io, VPS).

## 1. Pubblicare il backend

Crea un nuovo Web Service usando la cartella `server`.
Il servizio deve usare il Dockerfile incluso.

Variabili ambiente richieste:

- `OPENAI_API_KEY` = la tua chiave API OpenAI
- `ALLOWED_ORIGIN` = `https://audiotranslate-en-it.github.io`
- `TEXT_MODEL` = `gpt-5.6-luna`
- `TRANSCRIBE_MODEL` = `gpt-4o-transcribe-diarize`

Non inserire mai la chiave API in GitHub o in `config.js`.

## 2. Collegare GitHub Pages al backend

Quando il backend è online, copia il suo URL pubblico.

Apri `config.js` e imposta:

```js
window.AUDIOTRANSLATE_API = "https://TUO-BACKEND.example.com";
```

Poi carica/aggiorna su GitHub Pages:
- index.html
- styles.css
- app.js
- config.js
- manifest.webmanifest
- icon.svg
- sw.js

## Logica filtro lingua

Ogni blocco viene:
1. convertito in audio mono compresso;
2. trascritto con speaker diarization;
3. analizzato segmento per segmento;
4. classificato EN / IT / MIXED / OTHER / NOISE;
5. le parti EN vengono conservate e tradotte;
6. le parti IT vengono escluse e, se richiesto, mostrate nel pannello “Parti italiane escluse”.

La modalità “Forte” scarta anche segmenti linguistici incerti.

## Nota

L'uso delle API è separato dall'abbonamento ChatGPT e richiede un account API con fatturazione abilitata.
