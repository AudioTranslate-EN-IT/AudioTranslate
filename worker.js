import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

env.allowLocalModels = false;

let transcriber = null;
let transcriberModel = null;
let translator = null;

function post(id, payload) {
  self.postMessage({ id, ...payload });
}

function makeProgress(id, stage, title) {
  return (info) => {
    const raw = typeof info?.progress === 'number' ? info.progress : 0;
    const progress = raw > 1 ? raw / 100 : raw;
    const name = info?.file || info?.name || info?.status || 'modello';
    post(id, {
      type: 'progress', stage, progress: Math.max(0, Math.min(1, progress)), title,
      message: info?.status === 'ready' ? 'Modello pronto.' : `Caricamento ${name}…`
    });
  };
}

async function getTranscriber(id, model) {
  if (!transcriber || transcriberModel !== model) {
    transcriber = null;
    transcriberModel = model;
    post(id, { type: 'progress', stage: 'transcribe', progress: 0.02, title: 'Whisper', message: 'Caricamento del modello di trascrizione…' });
    transcriber = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      progress_callback: makeProgress(id, 'transcribe', 'Whisper'),
    });
  }
  return transcriber;
}

async function getTranslator(id) {
  if (!translator) {
    post(id, { type: 'progress', stage: 'translate', progress: 0.02, title: 'Traduzione', message: 'Caricamento del modello inglese → italiano…' });
    translator = await pipeline('translation', 'Xenova/opus-mt-en-it', {
      dtype: 'q8',
      progress_callback: makeProgress(id, 'translate', 'Traduzione'),
    });
  }
  return translator;
}

self.addEventListener('message', async (event) => {
  const { id, task } = event.data || {};
  if (!id || !task) return;

  try {
    if (task === 'transcribe') {
      const { model, audio, timestamps } = event.data;
      const modelName = model || 'Xenova/whisper-tiny.en';
      const pipe = await getTranscriber(id, modelName);

      post(id, { type: 'progress', stage: 'transcribe', progress: 0.84, title: 'Trascrizione', message: 'Analisi dell’audio in inglese…' });

      const generationOptions = {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: timestamps ? true : false,
      };

      // I modelli ".en" sono English-only e non accettano language/task.
      if (!modelName.endsWith('.en')) {
        generationOptions.language = 'english';
        generationOptions.task = 'transcribe';
      }

      const output = await pipe(audio, generationOptions);
      post(id, { type: 'result', data: output });
      return;
    }

    if (task === 'translate') {
      const chunks = event.data.chunks || [];
      const pipe = await getTranslator(id);
      const translated = [];

      for (let i = 0; i < chunks.length; i++) {
        post(id, {
          type: 'progress',
          stage: 'translate',
          progress: chunks.length ? i / chunks.length : 0,
          title: 'Traduzione',
          message: `Traduzione blocco ${i + 1} di ${chunks.length}…`
        });

        const out = await pipe(chunks[i], { max_new_tokens: 512 });
        const item = Array.isArray(out) ? out[0] : out;
        translated.push(item?.translation_text || item?.generated_text || '');
      }

      post(id, { type: 'result', data: translated });
      return;
    }

    throw new Error(`Operazione non supportata: ${task}`);
  } catch (error) {
    console.error(error);
    post(id, { type: 'error', error: error?.message || String(error) });
  }
});
