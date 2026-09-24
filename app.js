const $ = (id) => document.getElementById(id);

const dropZone = $('dropZone');
const chooseBtn = $('chooseBtn');
const fileInput = $('fileInput');
const filePanel = $('filePanel');
const fileName = $('fileName');
const fileInfo = $('fileInfo');
const audioPlayer = $('audioPlayer');
const removeBtn = $('removeBtn');
const startBtn = $('startBtn');
const modelSelect = $('modelSelect');
const timestampsCheck = $('timestampsCheck');
const progressCard = $('progressCard');
const progressBar = $('progressBar');
const progressPct = $('progressPct');
const statusTitle = $('statusTitle');
const statusText = $('statusText');
const results = $('results');
const englishText = $('englishText');
const italianText = $('italianText');
const segmentsCard = $('segmentsCard');
const segmentsList = $('segmentsList');
const downloadEnBtn = $('downloadEnBtn');
const downloadItBtn = $('downloadItBtn');
const downloadSrtBtn = $('downloadSrtBtn');

let selectedFile = null;
let selectedUrl = null;
let currentChunks = [];
let worker = null;
let isRunning = false;

const formatBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  if (!bytes) return '0 B';
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

const formatTime = (seconds = 0) => {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const formatSrtTime = (seconds = 0) => {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
};

function setProgress(percent, title, text) {
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  progressBar.style.width = `${p}%`;
  progressPct.textContent = `${p}%`;
  if (title) statusTitle.textContent = title;
  if (text) statusText.textContent = text;
}

function setFile(file) {
  if (!file) return;
  selectedFile = file;
  if (selectedUrl) URL.revokeObjectURL(selectedUrl);
  selectedUrl = URL.createObjectURL(file);
  fileName.textContent = file.name;
  fileInfo.textContent = `${formatBytes(file.size)} · ${file.type || 'audio'}`;
  audioPlayer.src = selectedUrl;
  filePanel.classList.remove('hidden');
  startBtn.disabled = false;
  results.classList.add('hidden');
  segmentsCard.classList.add('hidden');
}

function clearFile() {
  if (isRunning) return;
  selectedFile = null;
  fileInput.value = '';
  audioPlayer.removeAttribute('src');
  audioPlayer.load();
  if (selectedUrl) URL.revokeObjectURL(selectedUrl);
  selectedUrl = null;
  filePanel.classList.add('hidden');
  startBtn.disabled = true;
}

chooseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => setFile(fileInput.files?.[0]));
removeBtn.addEventListener('click', clearFile);

['dragenter', 'dragover'].forEach((name) => dropZone.addEventListener(name, (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((name) => dropZone.addEventListener(name, (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

async function decodeAndResample(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Il browser non supporta Web Audio API. Prova Chrome o Edge aggiornato.');
  const ctx = new AudioCtx();
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channels = buffer.numberOfChannels;
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
    }
    const targetRate = 16000;
    if (buffer.sampleRate === targetRate) return mono;
    const ratio = buffer.sampleRate / targetRate;
    const newLength = Math.round(mono.length / ratio);
    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const src = i * ratio;
      const left = Math.floor(src);
      const right = Math.min(left + 1, mono.length - 1);
      const frac = src - left;
      out[i] = mono[left] * (1 - frac) + mono[right] * frac;
    }
    return out;
  } catch (error) {
    throw new Error(`Impossibile decodificare questo formato audio nel browser. ${error.message || ''}`.trim());
  } finally {
    await ctx.close().catch(() => {});
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker('./worker.js?v=2', { type: 'module' });
  return worker;
}

function runWorker(payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = crypto.randomUUID();
    const onMessage = (event) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === 'progress') {
        const mapped = msg.stage === 'transcribe'
          ? 15 + (msg.progress || 0) * 0.45
          : 62 + (msg.progress || 0) * 0.34;
        setProgress(mapped, msg.title, msg.message);
        return;
      }
      w.removeEventListener('message', onMessage);
      if (msg.type === 'error') reject(new Error(msg.error || 'Errore durante l’elaborazione.'));
      else resolve(msg.data);
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, ...payload }, transfer);
  });
}

function chunkText(text, maxChars = 900) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current + ' ' + s).trim().length <= maxChars) {
      current = (current + ' ' + s).trim();
    } else {
      if (current) chunks.push(current);
      if (s.length <= maxChars) current = s;
      else {
        for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function renderSegments(chunks = []) {
  segmentsList.innerHTML = '';
  currentChunks = chunks.filter((x) => Array.isArray(x.timestamp));
  if (!currentChunks.length) {
    segmentsCard.classList.add('hidden');
    return;
  }
  for (const chunk of currentChunks) {
    const row = document.createElement('div');
    row.className = 'segment';
    const time = document.createElement('time');
    time.textContent = `${formatTime(chunk.timestamp[0])} → ${formatTime(chunk.timestamp[1])}`;
    const p = document.createElement('p');
    p.textContent = (chunk.text || '').trim();
    row.append(time, p);
    segmentsList.appendChild(row);
  }
  segmentsCard.classList.remove('hidden');
}

async function start() {
  if (!selectedFile || isRunning) return;
  isRunning = true;
  startBtn.disabled = true;
  removeBtn.disabled = true;
  results.classList.add('hidden');
  segmentsCard.classList.add('hidden');
  progressCard.classList.remove('hidden');
  englishText.value = '';
  italianText.value = '';
  currentChunks = [];

  try {
    setProgress(3, 'Lettura audio', 'Decodifica del file sul dispositivo…');
    const audio = await decodeAndResample(selectedFile);
    setProgress(12, 'Audio pronto', 'Avvio del modello Whisper…');

    const transcription = await runWorker({
      task: 'transcribe',
      model: modelSelect.value,
      audio,
      timestamps: timestampsCheck.checked,
    }, [audio.buffer]);

    const transcript = (transcription.text || '').trim();
    if (!transcript) throw new Error('Non è stato rilevato testo parlato nel file audio.');
    englishText.value = transcript;
    renderSegments(transcription.chunks || []);

    const parts = chunkText(transcript);
    setProgress(62, 'Traduzione', `Traduzione in italiano (${parts.length} blocchi)…`);
    const translated = await runWorker({ task: 'translate', chunks: parts });
    italianText.value = translated.join('\n\n').trim();
    results.classList.remove('hidden');
    setProgress(100, 'Completato', 'Trascrizione e traduzione terminate.');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error(error);
    setProgress(0, 'Errore', error.message || 'Si è verificato un errore.');
    alert(error.message || 'Si è verificato un errore.');
  } finally {
    isRunning = false;
    startBtn.disabled = !selectedFile;
    removeBtn.disabled = false;
  }
}
startBtn.addEventListener('click', start);

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = $(btn.dataset.copy);
    await navigator.clipboard.writeText(target.value || '');
    const old = btn.textContent;
    btn.textContent = 'Copiato';
    setTimeout(() => (btn.textContent = old), 1200);
  });
});

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const baseName = () => (selectedFile?.name || 'audio').replace(/\.[^.]+$/, '');
downloadEnBtn.addEventListener('click', () => downloadText(`${baseName()}-EN.txt`, englishText.value));
downloadItBtn.addEventListener('click', () => downloadText(`${baseName()}-IT.txt`, italianText.value));
downloadSrtBtn.addEventListener('click', () => {
  const srt = currentChunks.map((c, i) => {
    const [start = 0, end = start] = c.timestamp || [];
    return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${(c.text || '').trim()}\n`;
  }).join('\n');
  downloadText(`${baseName()}-EN.srt`, srt, 'application/x-subrip;charset=utf-8');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
