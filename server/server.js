import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TEXT_MODEL = process.env.TEXT_MODEL || "gpt-5.6-luna";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe-diarize";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 420); // 7 min
const OVERLAP_SECONDS = Number(process.env.OVERLAP_SECONDS || 2);

if (!OPENAI_API_KEY) console.warn("ATTENZIONE: OPENAI_API_KEY non configurata.");

const app = express();
app.use(express.json({limit:"2mb"}));

app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(ALLOWED_ORIGIN==="*" || !origin || origin===ALLOWED_ORIGIN){
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN==="*" ? "*" : origin);
  }
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});

const uploadDir=path.join(os.tmpdir(),"audiotranslate-uploads");
await fsp.mkdir(uploadDir,{recursive:true});
const upload=multer({
  dest:uploadDir,
  limits:{fileSize:500*1024*1024},
  fileFilter:(req,file,cb)=>{
    const ok=/^(audio|video)\//.test(file.mimetype)||/\.(mp3|m4a|wav|mp4|mpeg|mpga|webm)$/i.test(file.originalname);
    cb(ok?null:new Error("Formato audio non supportato."),ok);
  }
});

const jobs=new Map();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dur=x=>Math.max(0,(Number(x?.end)||0)-(Number(x?.start)||0));

function publicJob(j){
  return {
    id:j.id,status:j.status,progress:j.progress,statusTitle:j.statusTitle,statusDetail:j.statusDetail,
    currentChunk:j.currentChunk,totalChunks:j.totalChunks,stats:j.stats,error:j.error||null,
    result:j.status==="completed"?j.result:null
  };
}
function update(j,patch){Object.assign(j,patch);j.updatedAt=Date.now()}

function execFile(cmd,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:["ignore","pipe","pipe"]});
    let out="",err="";
    p.stdout.on("data",d=>out+=d);p.stderr.on("data",d=>err+=d);
    p.on("error",reject);
    p.on("close",code=>code===0?resolve({out,err}):reject(new Error(`${cmd} terminato con codice ${code}: ${err.slice(-1000)}`)));
  });
}
async function probeDuration(file){
  const {out}=await execFile("ffprobe",["-v","error","-show_entries","format=duration","-of","default=nw=1:nk=1",file]);
  const n=Number(out.trim()); if(!Number.isFinite(n)) throw new Error("Impossibile leggere la durata audio."); return n;
}
async function makeChunk(input,out,start,length){
  await execFile("ffmpeg",[
    "-y","-ss",String(start),"-t",String(length),"-i",input,
    "-vn","-ac","1","-ar","16000","-c:a","libmp3lame","-b:a","64k",out
  ]);
}

async function transcribeDiarized(file){
  const buf=await fsp.readFile(file);
  const form=new FormData();
  form.append("file",new Blob([buf],{type:"audio/mpeg"}),"chunk.mp3");
  form.append("model",TRANSCRIBE_MODEL);
  form.append("response_format","diarized_json");
  form.append("chunking_strategy","auto");

  const r=await fetch("https://api.openai.com/v1/audio/transcriptions",{
    method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},body:form
  });
  const text=await r.text();
  if(!r.ok) throw new Error(`Trascrizione: ${r.status} ${text.slice(0,700)}`);
  return JSON.parse(text);
}

const schema={
  type:"object",
  properties:{
    segments:{
      type:"array",
      items:{
        type:"object",
        properties:{
          index:{type:"integer"},
          language:{type:"string",enum:["en","it","mixed","other","noise"]},
          confidence:{type:"string",enum:["high","medium","low"]},
          english_text:{type:"string"},
          italian_translation:{type:"string"},
          excluded_text:{type:"string"}
        },
        required:["index","language","confidence","english_text","italian_translation","excluded_text"],
        additionalProperties:false
      }
    }
  },
  required:["segments"],additionalProperties:false
};

function outputText(response){
  if(typeof response.output_text==="string") return response.output_text;
  for(const item of response.output||[]){
    for(const c of item.content||[]) if(c.type==="output_text"&&typeof c.text==="string") return c.text;
  }
  throw new Error("Risposta testuale non trovata.");
}

async function classifyAndTranslate(segments,filterMode){
  const compact=segments.map((s,i)=>({
    index:i,speaker:s.speaker||"speaker",start:Number(s.start)||0,end:Number(s.end)||0,text:String(s.text||"").trim()
  }));
  const strict=filterMode==="strict";
  const instruction = `Sei il motore linguistico di una app professionale per lezioni universitarie.
Ricevi segmenti già trascritti con speaker e timestamp.
Per OGNI segmento:
- identifica se il parlato è inglese, italiano, misto, altra lingua o rumore;
- english_text deve contenere SOLO il contenuto effettivamente pronunciato in inglese, senza inventare o parafrasare;
- italian_translation deve essere una traduzione fedele in italiano di english_text;
- excluded_text contiene il contenuto non inglese da escludere;
- per un segmento mixed, separa con prudenza la parte inglese dalla parte italiana.
${strict ? "MODALITÀ FORTE: se la lingua è incerta o fortemente mista, escludi il segmento anziché rischiare di inserire italiano nella trascrizione inglese." : "MODALITÀ BILANCIATA: conserva l'inglese chiaramente riconoscibile anche nei segmenti misti."}
Non correggere il contenuto tecnico salvo punteggiatura minima. Restituisci un elemento per ogni index ricevuto.`;

  const r=await fetch("https://api.openai.com/v1/responses",{
    method:"POST",
    headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      model:TEXT_MODEL,
      input:[
        {role:"system",content:instruction},
        {role:"user",content:JSON.stringify(compact)}
      ],
      text:{format:{type:"json_schema",name:"lecture_language_filter",strict:true,schema}}
    })
  });
  const raw=await r.text();
  if(!r.ok) throw new Error(`Filtro linguistico: ${r.status} ${raw.slice(0,700)}`);
  const parsed=JSON.parse(raw);
  return JSON.parse(outputText(parsed)).segments;
}

function mergeSegments(rawSegments, analyzed, baseStart, discardBefore, settings){
  const kept=[],excluded=[];
  for(let i=0;i<rawSegments.length;i++){
    const raw=rawSegments[i],a=analyzed.find(x=>x.index===i);
    if(!a)continue;
    const localStart=Number(raw.start)||0,localEnd=Number(raw.end)||localStart;
    if(localEnd<=discardBefore) continue; // rimuove il doppione nell'overlap
    const start=baseStart+localStart,end=baseStart+localEnd;
    const english=(a.english_text||"").trim();
    const ex=(a.excluded_text||"").trim();
    if(english){
      kept.push({start,end,speaker:raw.speaker||"speaker",text:english,translation:(a.italian_translation||"").trim(),language:a.language,confidence:a.confidence});
    }
    if(ex && settings.keepExcluded){
      excluded.push({start,end,speaker:raw.speaker||"speaker",text:ex,language:a.language,confidence:a.confidence});
    }
  }

  if(settings.speakerMode==="dominant_english" && kept.length){
    const totals=new Map();
    for(const x of kept) totals.set(x.speaker,(totals.get(x.speaker)||0)+dur(x));
    const dominant=[...totals.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
    if(dominant){
      const removed=kept.filter(x=>x.speaker!==dominant);
      kept.splice(0,kept.length,...kept.filter(x=>x.speaker===dominant));
      if(settings.keepExcluded) for(const x of removed) excluded.push({...x,text:x.text,language:"en-other-speaker"});
    }
  }
  return {kept,excluded};
}

async function processJob(job){
  const settings=job.settings;
  try{
    update(job,{status:"processing",progress:12,statusTitle:"Analisi audio",statusDetail:"Lettura della durata e preparazione dei blocchi…"});
    const duration=await probeDuration(job.filePath);
    const total=Math.max(1,Math.ceil(duration/CHUNK_SECONDS));
    job.totalChunks=total;
    const english=[],excluded=[];
    let engSec=0,itSec=0;

    for(let i=0;i<total;i++){
      const nominalStart=i*CHUNK_SECONDS;
      const actualStart=i===0?0:Math.max(0,nominalStart-OVERLAP_SECONDS);
      const discard=i===0?0:OVERLAP_SECONDS;
      const remaining=duration-actualStart;
      const length=Math.min(CHUNK_SECONDS+(i===0?0:OVERLAP_SECONDS),remaining);
      const chunkPath=path.join(uploadDir,`${job.id}-${i}.mp3`);

      update(job,{
        currentChunk:i+1,
        progress:15+Math.round((i/total)*78),
        statusTitle:"Preparazione blocco audio",
        statusDetail:`Blocco ${i+1} di ${total}`
      });

      await makeChunk(job.filePath,chunkPath,actualStart,length);

      update(job,{
        progress:18+Math.round((i/total)*78),
        statusTitle:"Riconoscimento voci",
        statusDetail:`Trascrizione e separazione interlocutori · blocco ${i+1}/${total}`
      });
      const tr=await transcribeDiarized(chunkPath);
      const segs=Array.isArray(tr.segments)?tr.segments:[];

      update(job,{
        progress:21+Math.round((i/total)*78),
        statusTitle:"Filtro inglese / italiano",
        statusDetail:`Analisi lingua e traduzione · blocco ${i+1}/${total}`
      });
      const analyzed=segs.length?await classifyAndTranslate(segs,settings.italianFilter):[];
      const merged=mergeSegments(segs,analyzed,actualStart,discard,settings);
      english.push(...merged.kept); excluded.push(...merged.excluded);
      engSec=english.reduce((s,x)=>s+dur(x),0);
      itSec=excluded.filter(x=>x.language==="it"||x.language==="mixed").reduce((s,x)=>s+dur(x),0);
      job.stats={englishSeconds:engSec,italianSeconds:itSec};
      await fsp.rm(chunkPath,{force:true});
    }

    english.sort((a,b)=>a.start-b.start); excluded.sort((a,b)=>a.start-b.start);
    const englishText=english.map(x=>x.text).join(" ").replace(/\s+/g," ").trim();
    const italianText=english.map(x=>x.translation).filter(Boolean).join(" ").replace(/\s+/g," ").trim();

    const result={
      durationSeconds:duration,
      stats:{englishSeconds:engSec,italianSeconds:itSec},
      englishText,italianText,
      englishSegments:settings.timestamps?english:english.map(({text,translation})=>({text,translation})),
      excludedSegments:settings.keepExcluded?excluded:[]
    };
    update(job,{status:"completed",progress:100,statusTitle:"Completato",statusDetail:"Trascrizione e traduzione pronte.",result});
  }catch(err){
    console.error(err);
    update(job,{status:"failed",error:err?.message||String(err),statusTitle:"Errore",statusDetail:err?.message||String(err)});
  }finally{
    await fsp.rm(job.filePath,{force:true}).catch(()=>{});
  }
}

app.get("/api/health",(req,res)=>res.json({ok:true,version:"3.0.0",openaiConfigured:Boolean(OPENAI_API_KEY)}));

app.post("/api/jobs",upload.single("audio"),async(req,res)=>{
  if(!OPENAI_API_KEY){
    if(req.file) await fsp.rm(req.file.path,{force:true}).catch(()=>{});
    return res.status(503).json({error:"OPENAI_API_KEY non configurata sul server."});
  }
  if(!req.file) return res.status(400).json({error:"File audio mancante."});
  const id=crypto.randomUUID();
  const settings={
    mode:req.body.mode||"lecture_en",
    speakerMode:req.body.speakerMode||"all_english",
    italianFilter:req.body.italianFilter||"balanced",
    keepExcluded:req.body.keepExcluded!=="false",
    timestamps:req.body.timestamps!=="false"
  };
  const job={
    id,status:"queued",progress:10,statusTitle:"In coda",statusDetail:"Il server ha ricevuto la lezione.",
    filePath:req.file.path,originalName:req.file.originalname,settings,currentChunk:0,totalChunks:0,
    stats:{englishSeconds:0,italianSeconds:0},createdAt:Date.now(),updatedAt:Date.now()
  };
  jobs.set(id,job);
  res.status(202).json({id});
  setImmediate(()=>processJob(job));
});

app.get("/api/jobs/:id",(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j)return res.status(404).json({error:"Elaborazione non trovata o scaduta."});
  res.json(publicJob(j));
});

// pulizia memoria dei job vecchi
setInterval(()=>{
  const cutoff=Date.now()-12*60*60*1000;
  for(const [id,j] of jobs) if(j.updatedAt<cutoff) jobs.delete(id);
},30*60*1000).unref();

app.use((err,req,res,next)=>{
  console.error(err);
  if(req.file?.path) fsp.rm(req.file.path,{force:true}).catch(()=>{});
  res.status(400).json({error:err?.message||"Richiesta non valida."});
});

app.listen(PORT,()=>console.log(`AudioTranslate API in ascolto sulla porta ${PORT}`));
