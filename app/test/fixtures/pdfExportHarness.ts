import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { registerPdfExport } from '../../electron/pdfExport';
import { readSettings, saveSettings } from '../../electron/settings';
async function run() {
const root = process.env.GALPI_PDF_QA_ROOT!;
const appRoot = process.env.GALPI_APP_ROOT!;
app.setPath('appData', path.join(root, 'data'));
app.setPath('userData', path.join(root, 'electron-profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'paper', privileges: { standard:true, secure:true, supportFetchAPI:true, stream:true } }]);
const dir = path.join(root, 'data/Galpi/docs/pdf-qa');
let state:any = {};
const blocks = [
  { id:'h1', page:1, type:'heading', level:1, text:'Bilingual reading', bbox:[40,40,570,70] },
  { id:'b1', page:1, type:'paragraph', text:'A long translated paragraph to exercise pagination. The original is preserved.', bbox:[40,85,570,200] },
  { id:'b2', page:2, type:'paragraph', text:'A paragraph with a mathematical expression and escaped dollars.', bbox:[40,80,570,150] },
  { id:'b3', page:3, type:'paragraph', text:'This paragraph does not have a translation yet.', bbox:[40,80,570,150] },
  { id:'b4', page:4, type:'paragraph', text:'A translation just over one sheet must stay together.', bbox:[40,80,570,600] },
];
let entries:any = {
 h1:{ko:'원문과 번역을 함께 읽기'},
 b1:{ko: Array.from({length:200},(_,i)=>`문장${i+1}: 투자자의 기대와 시장 가격의 관계를 분석하고 원문에서 제시한 가정을 확인한다.`).join(' ')},
 b2:{ko:'시장 수익률과 위험의 관계는 $\\alpha + \\beta_{i} R_{m}$로 나타낸다. 원문 그림과 표는 확대해도 선명하게 유지한다. 마지막 문장까지 번역을 보존한다. <script>window.__injected=true</script> 가격은 \\$17.00이다.'},
 b4:{ko:Array.from({length:38},(_,i)=>`경계줄${String(i+1).padStart(2,'0')}: 해당 쪽만 글자 크기를 조절합니다.`).join('\n')}
};
await fs.mkdir(dir,{recursive:true});
const pdf=await PDFDocument.create(); const font=await pdf.embedFont(StandardFonts.Helvetica);
for(let i=1;i<=4;i++) {
 const page=pdf.addPage([612,792]);
 page.drawText(`ORIGINAL PAPER - PAGE ${i}`,{x:42,y:736,size:20,font});
 page.drawText('Original PDF text remains searchable and selectable.',{x:42,y:696,size:12,font});
 page.drawText('The vector figure below must stay sharp.',{x:42,y:674,size:12,font});
 page.drawRectangle({x:42,y:360,width:510,height:270,borderWidth:1,borderColor:rgb(.25,.45,.35),color:rgb(.96,.98,.96)});
 page.drawLine({start:{x:70,y:390},end:{x:500,y:590},thickness:2,color:rgb(.15,.45,.28)});
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 612 792"><rect width="612" height="792" fill="white"/><text x="42" y="56" font-family="Helvetica" font-size="20">ORIGINAL PAPER - PAGE ${i}</text><text x="42" y="96" font-family="Helvetica" font-size="12">Original PDF text remains searchable and selectable.</text><text x="42" y="118" font-family="Helvetica" font-size="12">The vector figure below must stay sharp.</text><rect x="42" y="162" width="510" height="270" stroke="#407359" fill="#f5faf5"/><line x1="70" y1="402" x2="500" y2="202" stroke="#267347" stroke-width="2"/></svg>`;
 await fs.writeFile(path.join(dir,`page-${i}.svg`),svg);
}
await fs.writeFile(path.join(dir,'source.pdf'),await pdf.save());
let doc:any={doc_id:'pdf-qa',title:'원문 + 번역 저장 검증',authors:'Ada Lovelace, Alan Turing',year:2026,page_count:4,source_pdf:'source.pdf',blocks,pages:[1,2,3,4].map(index=>({index,width_pt:612,height_pt:792,image:`page-${index}.svg`,is_vector:true,svg:`page-${index}.svg`,image_width_px:612,image_height_px:792,dpi:72}))};
if (process.env.GALPI_PDF_REAL_DOC) {
 for (const name of ['document.json', 'source.pdf', 'pages', 'assets', 'ai']) {
   const from = path.join(process.env.GALPI_PDF_REAL_DOC!, name);
   try { await fs.cp(from, path.join(dir, name), {recursive:true}); } catch (e:any) { if (e.code !== 'ENOENT') throw e; }
 }
 doc=JSON.parse(await fs.readFile(path.join(dir,'document.json'),'utf8'));
 doc.doc_id='pdf-qa';
 entries=Object.fromEntries(doc.blocks.filter((b:any)=>b.text).map((b:any)=>[b.id,{ko:'검증용 번역: 원문 페이지와 함께 조판하여 저장 결과를 확인합니다. '+ '수익률과 거래량의 관계를 분석하고 자료와 모형의 가정을 확인한다. '.repeat(5)}]));
}
await fs.writeFile(path.join(dir,'document.json'),JSON.stringify(doc));
const secondDir=path.join(root,'data/Galpi/docs/pdf-qa-2');
await fs.cp(dir,secondDir,{recursive:true});
const second={...doc,doc_id:'pdf-qa-2',title:'다른 논문 기본값 검증'};
await fs.writeFile(path.join(secondDir,'document.json'),JSON.stringify(second));
const replies:any = {
 'docs:list':()=>[doc,second].map(d=>({...d,state:'done',pages_done:d.page_count,finished:false})),
 'docs:load':(_e:any,id:string)=>id==='pdf-qa-2'?second:doc,
 'settings:load':()=>readSettings(), 'settings:save':async(_e:any,patch:any)=>{await saveSettings(patch);return true;}, 'ai:keyStatus':()=>({}),
 'library:load':()=>({folders:[],docs:{}}), 'library:save':()=>true, 'auto:status':()=>({}),
 'state:load':(_e:any,id:string)=>id==='pdf-qa-2'?{pdf_export:{fontSize:20,lineHeight:2.6,translationPercent:25}}:state, 'reading:update':(_e:any,_id:any,patch:any)=>(state={...state,...patch}),
 'agy:prewarm':()=>null, 'translate:isRunning':()=>false, 'translate:cached':async(_e:any,_id:string,items:any[])=>{
  if (!process.env.GALPI_PDF_REAL_DOC || !process.env.GALPI_PDF_CACHE_CONTEXT) return entries;
  const { TranslationCache } = await import('../../electron/ai/translationCache');
  const cache = await TranslationCache.open('pdf-qa');
  return cache.lookupAll(items, JSON.parse(process.env.GALPI_PDF_CACHE_CONTEXT));
 },
 'chat:list':()=>[], 'ai:chatModels':()=>({models:[],defaultId:'none'}),
 'summary:get':()=>null,'summary:state':()=>({running:false}),'usage:forDoc':()=>null,
 'app:version':()=> '0.3.2', 'export:saveHtml':()=>({canceled:true}),
};
for (const [channel,fn] of Object.entries(replies)) ipcMain.handle(channel,fn as any);
(dialog as any).showSaveDialog=async(...args:any[])=>{
 (globalThis as any).lastSaveDefault=args.at(-1).defaultPath;
 return {canceled:false,filePath:path.join(root,'bilingual.pdf')};
};
(shell as any).showItemInFolder=()=>{};
await app.whenReady();
registerPdfExport();
protocol.handle('paper',req=>{
 const url=new URL(req.url); const segs=url.pathname.slice(1).split('/').map(decodeURIComponent);
 return net.fetch(pathToFileURL(path.join(root,'data/Galpi/docs',...segs)).toString());
});
const win=new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{preload:path.join(appRoot,'dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
await win.loadFile(path.join(appRoot,'dist/index.html'));

}
void run().catch(e=>{console.error(e);app.exit(1)});
