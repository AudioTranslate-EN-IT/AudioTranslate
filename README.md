# AudioTranslate EN → IT

Webapp statica per GitHub Pages che:

1. carica un file audio dal dispositivo;
2. trascrive l'audio inglese con Whisper tramite Transformers.js;
3. traduce il testo in italiano con `Xenova/opus-mt-en-it`;
4. consente copia, modifica e download TXT;
5. può generare segmenti temporali e un file SRT inglese.

## Caratteristiche

- Nessuna API key.
- Nessun backend.
- L'audio non viene inviato a un server dell'applicazione.
- I modelli AI vengono scaricati dal repository Hugging Face e poi eseguiti nel browser.
- Compatibile con GitHub Pages.
- PWA installabile su browser compatibili.

## Pubblicazione su GitHub Pages

1. Crea un nuovo repository GitHub, ad esempio `AudioTranslate-EN-IT`.
2. Carica tutti i file di questa cartella nella root del repository.
3. Vai in **Settings → Pages**.
4. In **Build and deployment**, scegli **Deploy from a branch**.
5. Seleziona **main** e cartella **/(root)**, quindi salva.
6. Dopo la pubblicazione l'app sarà disponibile all'indirizzo indicato da GitHub Pages.

## Nota sulle prestazioni

La prima esecuzione richiede il download dei modelli. Whisper Base è più preciso ma richiede più memoria e download maggiori. Per smartphone o PC meno potenti usare Whisper Tiny.

## Modelli

- `Xenova/whisper-tiny.en`
- `Xenova/whisper-base.en`
- `Xenova/opus-mt-en-it`

L'app usa `@huggingface/transformers` 4.3.0 dal CDN jsDelivr.
