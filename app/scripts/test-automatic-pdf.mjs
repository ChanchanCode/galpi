import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
const require=createRequire(import.meta.url), {_electron}=await import('playwright-core');
const appRoot=path.resolve(import.meta.dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'galpi-auto-'));
await build({entryPoints:[path.join(appRoot,'test/fixtures/automaticPdfHarness.ts')],bundle:true,platform:'node',format:'cjs',
  outfile:path.join(appRoot,'dist-test/automaticPdfHarness.cjs'),external:['electron'],plugins:[{name:'mock-remote-ai',setup(b){
    b.onResolve({filter:/^\.\/service$/},()=>({path:path.join(appRoot,'test/fixtures/mockAI.ts')}));
  }}]});
const launch=restart=>_electron.launch({executablePath:require('electron'),args:[path.join(appRoot,'dist-test/automaticPdfHarness.cjs')],
  env:{...process.env,GALPI_AUTO_QA_ROOT:root,GALPI_APP_ROOT:appRoot,GALPI_AUTO_RESTART:restart?'1':''}});
const completed=(page,id,stage)=>page.evaluate(({id,stage})=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{off();reject(new Error(`Timed out waiting for ${id}: ${stage}`));},30000);
  const check=(statuses)=>{if(statuses[id]?.stage===stage){clearTimeout(timer);off();resolve(statuses[id]);}
    else if(stage==='done'&&statuses[id]?.stage==='error'){clearTimeout(timer);off();reject(new Error(statuses[id].error));}};
  const off=window.paperAPI.onAutoChanged(check);void window.paperAPI.autoStatus().then(check);
}),{id,stage});
const openSettings=async(page)=>{await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByRole('button',{name:'AI',exact:true}).click();};
let electron=await launch(false);const report={root};
try {
  const page=await electron.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openSettings(page);
  const option=page.getByRole('button',{name:'원문+번역 PDF 자동 저장',exact:true});
  await option.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="원문+번역 PDF 자동 저장"]')?.disabled===false);
  assert.equal(await option.getAttribute('aria-pressed'),'false');
  await electron.evaluate(()=>globalThis.qa.add('off'));
  await page.evaluate(()=>new Promise(r=>setTimeout(r,200)));
  assert.deepEqual(await electron.evaluate(()=>globalThis.qa.mockAI.calls),[]);
  assert.deepEqual(await fs.readdir(path.join(root,'downloads')),[]);
  await option.click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="원문+번역 PDF 자동 저장"]')?.getAttribute('aria-pressed')==='true'&&document.querySelector('[aria-label="원문+번역 PDF 자동 저장"]')?.disabled===false);
  await page.getByRole('button',{name:'처리 속도 빠르게',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="처리 속도 빠르게"]')?.getAttribute('aria-pressed')==='true');
  await page.screenshot({path:path.join(root,'options.png')});
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await page.evaluate(()=>window.paperAPI.pickPdfs().then(paths=>window.paperAPI.extractPdf(paths[0])));
  await completed(page,'auto','done');
  const status=(await page.evaluate(()=>window.paperAPI.autoStatus())).auto;
  report.path=status.pdfPath;assert.ok(status.pdfPath.startsWith(path.join(root,'downloads','Galpi')));
  const bytes=await fs.readFile(status.pdfPath),pdf=await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(),4);assert.ok(Math.abs(pdf.getPage(0).getWidth()-420*72/25.4)<.1);
  assert.equal(await electron.evaluate(()=>globalThis.saveDialogCalls),0);
  assert.equal(await page.getByRole('button',{name:'내보내기',exact:true}).count(),0);
  await page.getByRole('button',{name:'자동 저장 PDF 보기',exact:true}).click();
  assert.equal(await electron.evaluate(()=>globalThis.revealed),status.pdfPath);
  report.maxParallel=await electron.evaluate(()=>globalThis.qa.mockAI.max);assert.equal(report.maxParallel,4);
  const before=await fs.readdir(path.dirname(status.pdfPath));
  assert.equal(await electron.evaluate(async()=>globalThis.qa.saveAutomaticPdf('auto')),status.pdfPath);
  assert.deepEqual(await fs.readdir(path.dirname(status.pdfPath)),before);
  // One omitted block must retry alone and preserve already translated paragraphs.
  await electron.evaluate(async()=>{globalThis.qa.reset('partial');await globalThis.qa.makeDoc('partial');globalThis.qa.add('partial');});
  await completed(page,'partial','done');
  const calls=await electron.evaluate(()=>globalThis.qa.mockAI.calls);assert.deepEqual(calls.at(-1).ids,['b0']);
  const partial=(await page.evaluate(()=>window.paperAPI.autoStatus())).partial;
  assert.notEqual(partial.pdfPath,status.pdfPath);assert.deepEqual(await fs.readFile(status.pdfPath),bytes);
  // Missing translation cannot produce an apparently complete PDF.
  await electron.evaluate(async()=>{globalThis.qa.reset('missing');await globalThis.qa.makeDoc('missing');globalThis.qa.add('missing');});
  await completed(page,'missing','error');assert.equal((await page.evaluate(()=>window.paperAPI.autoStatus())).missing.pdfPath,undefined);
  assert.equal((await fs.readdir(path.dirname(status.pdfPath))).filter(f=>f.endsWith('.pdf')).length,2);
  // Fatal quota errors halt outstanding batches; a new healthy document still works.
  await electron.evaluate(async()=>{globalThis.qa.reset('quota');await globalThis.qa.makeDoc('quota');globalThis.qa.add('quota');});
  await completed(page,'quota','error');
  const quotaCalls=await electron.evaluate(()=>globalThis.qa.mockAI.calls.length);assert.ok(quotaCalls<=4);
  assert.match((await page.evaluate(()=>window.paperAPI.autoStatus())).quota.error,/quota/);
  // Same translator, same payload, same fake server latency: bounded serial vs parallel.
  report.serial=await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.setMode('balanced');await globalThis.qa.makeDoc('serial');
    const start=Date.now(),result=await globalThis.qa.translate('serial');return {ms:Date.now()-start,max:globalThis.qa.mockAI.max,result};});
  report.parallel=await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.setMode('fast');await globalThis.qa.makeDoc('parallel');
    const start=Date.now(),result=await globalThis.qa.translate('parallel');return {ms:Date.now()-start,max:globalThis.qa.mockAI.max,result};});
  assert.equal(report.serial.max,1);assert.equal(report.parallel.max,4);
  assert.equal(report.serial.result.done,24);assert.equal(report.parallel.result.done,24);
  assert.ok(report.parallel.ms<report.serial.ms*.7);
  // Automatic export must use the same global paper/font/margin defaults as manual export.
  await page.evaluate(()=>window.paperAPI.saveSettings({pdfExport:{paper:'a4',fontSize:13,paddingTop:12,lineHeight:1.8}}));
  await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.makeDoc('custom');globalThis.qa.add('custom');});
  await completed(page,'custom','done');
  const custom=(await page.evaluate(()=>window.paperAPI.autoStatus())).custom;
  const customPdf=await PDFDocument.load(await fs.readFile(custom.pdfPath));
  assert.ok(Math.abs(customPdf.getPage(0).getWidth()-297*72/25.4)<.1);
  assert.equal(customPdf.getPageCount(),4);
  // Plain markers and multiple definitions must pass through the real translator/cache.
  await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.makeDoc('notes',true);globalThis.qa.add('notes');});
  await completed(page,'notes','done');
  const noteCalls=await electron.evaluate(()=>globalThis.qa.mockAI.calls.flatMap(c=>c.ids).filter(id=>id.includes(':fn:')));
  assert.deepEqual(noteCalls,['notes5:fn:5','notes6:fn:6','notes6:fn:7']);
  const notesStatus=(await page.evaluate(()=>window.paperAPI.autoStatus())).notes;
  assert.ok((await fs.stat(notesStatus.pdfPath)).size>0);
  // An omitted note alone blocks export; retries must not repeat the body or other notes.
  await electron.evaluate(async()=>{globalThis.qa.reset('note-missing');await globalThis.qa.makeDoc('notes-missing',true);globalThis.qa.add('notes-missing');});
  await completed(page,'notes-missing','error');
  const noteRetries=await electron.evaluate(()=>globalThis.qa.mockAI.calls);
  assert.deepEqual(noteRetries.at(-1).ids,['notes6:fn:6']);
  assert.equal((await page.evaluate(()=>window.paperAPI.autoStatus()))['notes-missing'].pdfPath,undefined);
  report.notesTranslated=true;report.missingNoteBlocked=true;
  // User cancellation stops new batches and allows a cache-only restart of completed parts.
  await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.makeDoc('cancel');globalThis.qa.add('cancel');});
  await completed(page,'cancel','translate');
  await electron.evaluate(()=>globalThis.qa.remove('cancel'));
  assert.equal((await page.evaluate(()=>window.paperAPI.autoStatus())).cancel,undefined);
  assert.equal(await fs.stat(path.join(root,'data/Galpi/docs/cancel')).then(()=>true,()=>false),false);
  // Deletion during PDF preparation also settles the hidden window and leaves no download.
  const pdfCount=(await fs.readdir(path.dirname(status.pdfPath))).filter(f=>f.endsWith('.pdf')).length;
  await electron.evaluate(async()=>{globalThis.qa.reset();await globalThis.qa.makeDoc('cancel-pdf');globalThis.qa.add('cancel-pdf');});
  await completed(page,'cancel-pdf','pdf');
  await electron.evaluate(()=>globalThis.qa.remove('cancel-pdf'));
  assert.equal((await page.evaluate(()=>window.paperAPI.autoStatus()))['cancel-pdf'],undefined);
  assert.equal((await fs.readdir(path.dirname(status.pdfPath))).filter(f=>f.endsWith('.pdf')).length,pdfCount);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
} catch(error) {try{await (await electron.firstWindow()).screenshot({path:path.join(root,'failure.png')});}catch{}throw error;}
finally {await electron.close();}
electron=await launch(true);
try {
  const page=await electron.firstWindow();await openSettings(page);
  await page.waitForFunction(()=>document.querySelector('[aria-label="원문+번역 PDF 자동 저장"]')?.getAttribute('aria-pressed')==='true');
  assert.equal(await page.getByRole('button',{name:'처리 속도 빠르게',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'원문+번역 PDF 자동 저장',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="원문+번역 PDF 자동 저장"]')?.getAttribute('aria-pressed')==='false');
  assert.equal((await page.evaluate(()=>window.paperAPI.aiAuto())).pdf,false);
} finally {await electron.close();}
console.log(JSON.stringify({root,automaticPdf:report.path,pages:4,defaultOff:true,noSaveDialog:true,settingsSurviveRestart:true,
  maxParallel:report.maxParallel,serialMs:report.serial.ms,parallelMs:report.parallel.ms,
  timingSource:'deterministic 60ms mock AI requests; not a live model benchmark',missingBlocked:true,quotaStopped:true,cancelStopped:true,
  globalPdfSettingsUsed:true,cancelDuringPdfStops:true,notesTranslated:report.notesTranslated,missingNoteBlocked:report.missingNoteBlocked},null,2));
