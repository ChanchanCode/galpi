import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { registerPdfExport, saveAutomaticPdf, waitForAutomaticPdf } from "../../electron/pdfExport";
import { readSettings, saveSettings } from "../../electron/settings";
import { currentProcessing, processingMode } from "../../electron/processing";
import { autoOnQueued, autoOnExit, autoOnDeleted, autoTrBlocks, registerAutoPipeline } from "../../electron/ai/autoPipeline";
import { cachedTranslations, translateDocument, isTranslating, cancelDocTranslation, waitForDocTranslation } from "../../electron/ai/translateDoc";
import { mockAI } from "./mockAI";
import { closeCache } from "../../electron/ai/translationCache";
import { loadFootnoteDocument } from "../../electron/footnoteDocument";

async function run() {
  const root = process.env.GALPI_AUTO_QA_ROOT!, appRoot = process.env.GALPI_APP_ROOT!;
  app.setPath("appData", path.join(root, "data"));
  app.setPath("userData", path.join(root, "electron-profile"));
  await fs.mkdir(path.join(root, "downloads"), {recursive:true});
  app.setPath("downloads", path.join(root, "downloads"));
  const docs = path.join(root,"data/Galpi/docs");
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for(let i=1;i<=4;i++) pdf.addPage([612,792]).drawText(`ORIGINAL AUTOMATIC PDF PAGE ${i}`,{x:40,y:740,font,size:18});
  const source = await pdf.save();
  const makeDoc = async (id:string, withNotes=false) => {
    const dir=path.join(docs,id);await fs.mkdir(dir,{recursive:true});
    const blocks:any[]=Array.from({length:24},(_,i)=>({id:`b${i}`,page:Math.floor(i/6)+1,type:"paragraph",
      text:`Unique paragraph ${i}. `+"Expected returns depend on investor expectations and market risk. ".repeat(28)+(i===2?"$\\beta R_m$.":""),
      bbox:[40,40+(i%6)*90,570,100+(i%6)*90]}));
    if(withNotes) blocks.push(
      {id:'notes5',page:1,type:'footnote',text:'5 Tax efficiency of pooled investment vehicles.',bbox:[40,700,570,715]},
      {id:'notes6',page:1,type:'footnote',text:'<sup>6</sup> Investors use long term accounts. <sup>7</sup> Securities regulation changes issuance.',bbox:[40,720,570,750]});
    const doc={doc_id:id,title:"Automatic export QA",authors:"Ada Lovelace, Alan Turing",year:2026,page_count:4,
      source_pdf:"source.pdf",blocks,pages:[1,2,3,4].map(index=>({index,width_pt:612,height_pt:792,image:"not-needed.png",dpi:72}))};
    await fs.writeFile(path.join(dir,"source.pdf"),source);
    await fs.writeFile(path.join(dir,"document.json"),JSON.stringify(doc));
    await fs.writeFile(path.join(dir,"status.json"),JSON.stringify({state:"done"}));
    return doc;
  };
  const loadDoc = async(id:string)=>loadFootnoteDocument(path.join(docs,id));
  const add = (id:string) => {autoOnQueued(id);autoOnExit(id,0);};
  const listDocs = async()=> {
    const all=await fs.readdir(docs);const result=[];
    for(const id of all){const doc=await loadDoc(id);let saved:any;
      try{saved=JSON.parse(await fs.readFile(path.join(docs,id,"auto-pdf.json"),"utf8"));}catch{}
      result.push({...doc,state:"done",pages_done:4,autoPdfPath:saved?.path});}
    return result;
  };
  await fs.mkdir(docs,{recursive:true});
  await makeDoc("off");
  if (!process.env.GALPI_AUTO_RESTART) await saveSettings({ai:{auto:{translate:false,summary:false}}});
  const replies:Record<string,any>={
    "docs:list":listDocs,"docs:load":(_e:any,id:string)=>loadDoc(id),
    "settings:load":readSettings,"settings:save":async(_e:any,patch:any)=>{await saveSettings(patch);return true;},
    "ai:keyStatus":()=>({}),"library:load":()=>({folders:[],docs:{}}),"library:save":()=>true,"state:load":()=>({}),
    "ai:processing":async(_e:any,raw?:unknown)=>{if(raw!==undefined)await saveSettings({processingMode:processingMode(raw)});return currentProcessing(await readSettings());},
    "translate:cached":(_e:any,id:string,blocks:any[])=>cachedTranslations(id,blocks),
    "translate:isRunning":(_e:any,id:string)=>isTranslating(id),
    "translate:doc":(_e:any,opts:any)=>translateDocument(opts),
    "ai:status":()=>null,"agy:accounts":()=>[],"agy:quotaView":()=>({status:"error",at:Date.now()}),
    "usage:summary":()=>null,"ai:chatModels":()=>({models:[],default:"none"}),"ai:listModels":()=>[],
    "app:version":()=>"QA","pipeline:status":()=>({pythonOk:true,scriptOk:true}),
    "pdf:pick":()=>["synthetic.pdf"],"pipeline:extract":async()=>{await makeDoc("auto");add("auto");
      for(const w of BrowserWindow.getAllWindows())w.webContents.send("docs:changed");return {started:true,docId:"auto"};},
  };
  for(const [channel,handler] of Object.entries(replies))ipcMain.handle(channel,handler);
  (dialog as any).showSaveDialog=async()=>{(globalThis as any).saveDialogCalls++;return {canceled:true};};
  (shell as any).showItemInFolder=(file:string)=>{(globalThis as any).revealed=file;};
  (globalThis as any).saveDialogCalls=0;
  (globalThis as any).qa={mockAI,makeDoc,add,saveAutomaticPdf,autoOnDeleted,cancelDocTranslation,waitTranslation:waitForDocTranslation,
    remove:async(id:string)=>{autoOnDeleted(id);cancelDocTranslation(id);
      await Promise.all([waitForDocTranslation(id),waitForAutomaticPdf(id)]);await closeCache(id);await fs.rm(path.join(docs,id),{recursive:true,force:true});},
    translate:async(id:string)=>{const doc=await loadDoc(id);return translateDocument({docId:id,blocks:autoTrBlocks(doc)});},
    reset:(mode="ok")=>{mockAI.calls=[];mockAI.active=0;mockAI.max=0;mockAI.dropped=false;mockAI.mode=mode;},
    setMode:async(mode:string)=>saveSettings({processingMode:mode}),
  };
  await app.whenReady();
  registerPdfExport({preloadPath:path.join(appRoot,"dist-electron/preload.cjs"),
    loadWorker:(win,id)=>win.loadFile(path.join(appRoot,"dist/index.html"),{query:{autoPdf:id}})});
  registerAutoPipeline();
  const win=new BrowserWindow({show:false,width:1400,height:1000,
    webPreferences:{preload:path.join(appRoot,"dist-electron/preload.cjs"),contextIsolation:true,nodeIntegration:false}});
  await win.loadFile(path.join(appRoot,"dist/index.html"));
}
void run().catch(error=>{console.error(error);app.exit(1);});
