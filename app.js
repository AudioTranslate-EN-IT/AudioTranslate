const $ = (id) => document.getElementById(id);
const API = (window.AUDIOTRANSLATE_API || "").replace(/\/+$/, "");

const el = {
  apiBadge:$("apiBadge"), dropZone:$("dropZone"), chooseBtn:$("chooseBtn"), fileInput:$("fileInput"),
  filePanel:$("filePanel"), fileName:$("fileName"), fileMeta:$("fileMeta"), removeBtn:$("removeBtn"),
  startBtn:$("startBtn"), configWarning:$("configWarning"), mode:$("mode"), speakerMode:$("speakerMode"),
  italianFilter:$("italianFilter"), keepExcluded:$("keepExcluded"), timestamps:$("timestamps"),
  progressCard:$("progressCard"), statusTitle:$("statusTitle"), statusDetail:$("statusDetail"),
  progressPct:$("progressPct"), progressBar:$("progressBar"), chunkStat:$("chunkStat"),
  englishStat:$("englishStat"), italianStat:$("italianStat"), results:$("results"),
  durationMetric:$("durationMetric"), englishMetric:$("englishMetric"), italianMetric:$("italianMetric"),
  segmentsMetric:$("segmentsMetric"), englishText:$("englishText"), italianText:$("italianText"),
  excludedCard:$("excludedCard"), excludedToggle:$("excludedToggle"), excludedList:$("excludedList"),
  excludedCount:$("excludedCount"), downloadEn:$("downloadEn"), downloadIt:$("downloadIt"), downloadSrt:$("downloadSrt")
};

let selectedFile = null;
let currentJobId = null;
let currentResult = null;
let pollTimer = null;
let serverReady = false;

const fmtBytes = n => {
  const u=["B","KB","MB","GB"]; if(!n)return"0 B";
  const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),u.length-1);
  return `${(n/1024**i).toFixed(i?1:0)} ${u[i]}`;
};
const fmtTime = sec => {
  sec=Math.max(0,Math.round(Number(sec)||0));
  const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
  return h?`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`:`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};
const srtTime = sec => {
  const ms=Math.max(0,Math.round((Number(sec)||0)*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(x).padStart(3,"0")}`;
};

function refreshStartState(){
  el.startBtn.disabled = !selectedFile || !serverReady;
}

async function checkApi(){
  serverReady=false;
  refreshStartState();

  if(!API){
    el.apiBadge.textContent="Server: da configurare";
    el.apiBadge.className="badge bad";
    el.configWarning.textContent="Il backend non è configurato. Pubblica il servizio server e imposta il suo indirizzo in config.js.";
    el.configWarning.classList.remove("hidden");
    return;
  }

  el.apiBadge.textContent="Server: collegamento…";
  el.apiBadge.className="badge muted";

  try{
    const r=await fetch(`${API}/api/health`,{cache:"no-store"});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(`HTTP ${r.status}`);

    if(!data.openaiConfigured){
      el.apiBadge.textContent="Server: chiave API mancante";
      el.apiBadge.className="badge bad";
      el.configWarning.textContent="Il server è online, ma manca OPENAI_API_KEY nelle variabili ambiente del backend.";
      el.configWarning.classList.remove("hidden");
      return;
    }

    serverReady=true;
    el.apiBadge.textContent="Server: online";
    el.apiBadge.className="badge ok";
    el.configWarning.classList.add("hidden");
    refreshStartState();
  }catch(err){
    el.apiBadge.textContent="Server: non raggiungibile";
    el.apiBadge.className="badge bad";
    el.configWarning.textContent="Il backend non è ancora online. Se lo hai appena pubblicato, attendi il completamento del deploy e riprova.";
    el.configWarning.classList.remove("hidden");
  }
}

function selectFile(file){
  if(!file)return;
  selectedFile=file;
  el.fileName.textContent=file.name;
  el.fileMeta.textContent=`${fmtBytes(file.size)} · ${file.type||"audio"}`;
  el.filePanel.classList.remove("hidden");
  el.results.classList.add("hidden");
  refreshStartState();
}
function clearFile(){
  selectedFile=null;
  el.fileInput.value="";
  el.filePanel.classList.add("hidden");
  refreshStartState();
}
el.chooseBtn.addEventListener("click",()=>el.fileInput.click());
el.fileInput.addEventListener("change",()=>selectFile(el.fileInput.files?.[0]));
el.removeBtn.addEventListener("click",clearFile);
["dragenter","dragover"].forEach(ev=>el.dropZone.addEventListener(ev,e=>{e.preventDefault();el.dropZone.classList.add("dragover")}));
["dragleave","drop"].forEach(ev=>el.dropZone.addEventListener(ev,e=>{e.preventDefault();el.dropZone.classList.remove("dragover")}));
el.dropZone.addEventListener("drop",e=>selectFile(e.dataTransfer?.files?.[0]));
el.dropZone.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();el.fileInput.click()}});

function setProgress(p,title,detail){
  p=Math.max(0,Math.min(100,Math.round(p||0)));
  el.progressPct.textContent=`${p}%`;
  el.progressBar.style.width=`${p}%`;
  if(title)el.statusTitle.textContent=title;
  if(detail)el.statusDetail.textContent=detail;
}
function uploadJob(){
  return new Promise((resolve,reject)=>{
    const form=new FormData();
    form.append("audio",selectedFile);
    form.append("mode",el.mode.value);
    form.append("speakerMode",el.speakerMode.value);
    form.append("italianFilter",el.italianFilter.value);
    form.append("keepExcluded",String(el.keepExcluded.checked));
    form.append("timestamps",String(el.timestamps.checked));

    const xhr=new XMLHttpRequest();
    xhr.open("POST",`${API}/api/jobs`);
    xhr.upload.onprogress=e=>{
      if(e.lengthComputable){
        const p=Math.round((e.loaded/e.total)*10);
        setProgress(p,"Caricamento lezione",`${Math.round(e.loaded/1024/1024)} di ${Math.round(e.total/1024/1024)} MB`);
      }
    };
    xhr.onload=()=>{
      try{
        const data=JSON.parse(xhr.responseText||"{}");
        if(xhr.status<200||xhr.status>=300) throw new Error(data.error||`Errore ${xhr.status}`);
        resolve(data);
      }catch(err){reject(err)}
    };
    xhr.onerror=()=>reject(new Error("Errore di rete durante il caricamento."));
    xhr.send(form);
  });
}
async function pollJob(id){
  const r=await fetch(`${API}/api/jobs/${encodeURIComponent(id)}`,{cache:"no-store"});
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||"Impossibile leggere lo stato.");
  updateJobUi(data);
  if(data.status==="completed"){
    currentResult=data.result;
    renderResult(data.result);
    return;
  }
  if(data.status==="failed")throw new Error(data.error||"Elaborazione non riuscita.");
  pollTimer=setTimeout(()=>pollJob(id).catch(showError),1800);
}
function updateJobUi(job){
  setProgress(job.progress||10,job.statusTitle||"Elaborazione",job.statusDetail||"");
  el.chunkStat.textContent=job.totalChunks?`${job.currentChunk||0}/${job.totalChunks}`:"—";
  el.englishStat.textContent=job.stats?.englishSeconds!=null?fmtTime(job.stats.englishSeconds):"—";
  el.italianStat.textContent=job.stats?.italianSeconds!=null?fmtTime(job.stats.italianSeconds):"—";
}
function renderResult(r){
  setProgress(100,"Completato","Trascrizione e traduzione pronte.");
  el.englishText.value=r.englishText||"";
  el.italianText.value=r.italianText||"";
  el.durationMetric.textContent=fmtTime(r.durationSeconds);
  el.englishMetric.textContent=fmtTime(r.stats?.englishSeconds);
  el.italianMetric.textContent=fmtTime(r.stats?.italianSeconds);
  el.segmentsMetric.textContent=String(r.englishSegments?.length||0);
  renderExcluded(r.excludedSegments||[]);
  el.results.classList.remove("hidden");
  el.results.scrollIntoView({behavior:"smooth",block:"start"});
}
function renderExcluded(items){
  el.excludedList.innerHTML="";
  el.excludedCount.textContent=`${items.length} segmenti`;
  if(!items.length||!el.keepExcluded.checked){
    el.excludedCard.classList.add("hidden");
    return;
  }
  for(const x of items){
    const d=document.createElement("div");
    d.className="excluded-item";
    const t=document.createElement("time");
    t.textContent=`${fmtTime(x.start)} → ${fmtTime(x.end)} · ${x.speaker||"voce"} · ${x.language||"it"}`;
    const p=document.createElement("p");
    p.textContent=x.text||"";
    d.append(t,p);
    el.excludedList.appendChild(d);
  }
  el.excludedCard.classList.remove("hidden");
}
function showError(err){
  clearTimeout(pollTimer);
  setProgress(0,"Errore",err.message||String(err));
  alert(err.message||String(err));
  refreshStartState();
  el.removeBtn.disabled=false;
}
async function start(){
  if(!selectedFile||!serverReady)return;
  clearTimeout(pollTimer);
  currentResult=null;
  el.startBtn.disabled=true;
  el.removeBtn.disabled=true;
  el.results.classList.add("hidden");
  el.progressCard.classList.remove("hidden");
  setProgress(1,"Preparazione","Avvio dell’elaborazione professionale…");
  try{
    const job=await uploadJob();
    currentJobId=job.id;
    setProgress(11,"File ricevuto","Preparazione dei blocchi audio…");
    await pollJob(job.id);
  }catch(err){
    showError(err);
  }finally{
    refreshStartState();
    el.removeBtn.disabled=false;
  }
}
el.startBtn.addEventListener("click",start);
el.excludedToggle.addEventListener("click",()=>el.excludedList.classList.toggle("hidden"));

document.querySelectorAll("[data-copy]").forEach(btn=>btn.addEventListener("click",async()=>{
  const t=$(btn.dataset.copy);
  await navigator.clipboard.writeText(t.value||"");
  const old=btn.textContent;
  btn.textContent="Copiato";
  setTimeout(()=>btn.textContent=old,1000);
}));
function download(name,text,type="text/plain;charset=utf-8"){
  const b=new Blob([text],{type});
  const u=URL.createObjectURL(b);
  const a=document.createElement("a");
  a.href=u;a.download=name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(u);
}
const base=()=>((selectedFile?.name||"lezione").replace(/\.[^.]+$/,""));
el.downloadEn.addEventListener("click",()=>download(`${base()}-EN.txt`,el.englishText.value));
el.downloadIt.addEventListener("click",()=>download(`${base()}-IT.txt`,el.italianText.value));
el.downloadSrt.addEventListener("click",()=>{
  const seg=currentResult?.englishSegments||[];
  const s=seg.map((x,i)=>`${i+1}\n${srtTime(x.start)} --> ${srtTime(x.end)}\n${x.text}\n`).join("\n");
  download(`${base()}-EN.srt`,s,"application/x-subrip;charset=utf-8");
});

checkApi();
setInterval(checkApi,60000);
