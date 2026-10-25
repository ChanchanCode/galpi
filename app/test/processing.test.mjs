import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
for (const [name, entry] of Object.entries({processing:'electron/processing.ts',queue:'electron/ai/queue.ts',
  batches:'electron/ai/batchScheduler.ts',pdfFiles:'electron/pdfFiles.ts',settings:'electron/settings.ts'})) {
  await build({entryPoints:[entry],outfile:`dist-test/${name}.cjs`,bundle:true,platform:'node',format:'cjs',external:['electron']});
}
const { processingProfile } = require('../dist-test/processing.cjs');
const { JobQueue, PRIORITY_BATCH, PRIORITY_INTERACTIVE } = require('../dist-test/queue.cjs');
const { runBatches } = require('../dist-test/batches.cjs');
const { saveNewPdf } = require('../dist-test/pdfFiles.cjs');
const { autoOptions } = require('../dist-test/settings.cjs');
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};};
const tick = () => new Promise(setImmediate);

test('PDF automation defaults off and is independent of translate/summary toggles', () => {
  assert.deepEqual(autoOptions(),{translate:true,summary:true,pdf:false});
  assert.deepEqual(autoOptions({translate:false,summary:false,pdf:true}),{translate:false,summary:false,pdf:true});
  assert.equal(autoOptions({pdf:'true'}).pdf,false);
});
test('Resource policy scales up only with available CPU/RAM and retains a conservative mode', () => {
  const idle={cores:12,availableGB:12,load:2};
  assert.equal(processingProfile('auto',idle).translationConcurrency,4);
  assert.equal(processingProfile('auto',{...idle,load:11}).translationConcurrency,1);
  assert.equal(processingProfile('auto',{...idle,availableGB:3}).translationConcurrency,2);
  assert.equal(processingProfile('fast',{...idle,availableGB:1}).translationConcurrency,1);
  assert.equal(processingProfile('balanced',idle).translationConcurrency,1);
  assert.ok(processingProfile('fast',idle).extractionThreads > processingProfile('balanced',idle).extractionThreads);
  assert.equal(processingProfile('balanced',idle).extractionChunk,6);
  assert.equal(processingProfile('auto',idle).extractionChunk,12);
  assert.equal(processingProfile('fast',idle).extractionChunk,24);
  assert.equal(processingProfile('fast',{...idle,availableGB:1}).extractionChunk,6);
});
test('Batch queue reserves interactive capacity and does not oversubscribe waking waiters', async () => {
  const queue=new JobQueue(3,1), gate=deferred(), calls=[];
  const jobs=[0,1,2].map(i=>queue.run(`batch${i}`,async()=>{calls.push(i);await gate.promise;},PRIORITY_BATCH));
  await tick(); assert.deepEqual(calls,[0,1]); assert.equal(queue.stats.active,2);
  await queue.run('selection',async()=>calls.push('selection'),PRIORITY_INTERACTIVE);
  assert.deepEqual(calls,[0,1,'selection']);
  gate.resolve(); await Promise.all(jobs);
  assert.deepEqual(calls,[0,1,'selection',2]); assert.equal(queue.stats.active,0);
});
test('A lower queue limit drains existing work and queued cancellation never starts the job', async () => {
  const queue=new JobQueue(3,1), gate=deferred();
  const first=queue.run('first',()=>gate.promise,PRIORITY_BATCH);
  const second=queue.run('second',()=>gate.promise,PRIORITY_BATCH);
  const third=queue.run('third',async()=>assert.fail('canceled job started'),PRIORITY_BATCH);
  const rejected=assert.rejects(third,/canceled/);
  await tick();queue.setLimit(2);
  assert.equal(queue.cancelWaitingPrefix('third',new Error('canceled')),1);
  await rejected;gate.resolve();await Promise.all([first,second]);assert.equal(queue.stats.active,0);
});
test('Scheduler bounds parallelism, adapts down, and stops starting batches after a fatal error', async () => {
  let active=0,max=0,limit=4,stopped=false;const started=[];
  await runBatches(Array.from({length:20},(_,i)=>i),()=>limit,async(i)=>{
    started.push(i);max=Math.max(max,++active);
    await tick(); active--;
    if(i===0){limit=1;stopped=true;}
  },()=>stopped);
  assert.equal(max,4);assert.deepEqual(started,[0,1,2,3]);assert.equal(active,0);
});
test('Unexpected batch errors settle peers without starting the remaining paper', async () => {
  const started=[];
  await assert.rejects(runBatches([0,1,2,3,4,5],()=>2,async(i)=>{
    started.push(i);await tick();if(i===0)throw new Error('unexpected');
  },()=>false),/unexpected/);
  assert.deepEqual(started,[0,1]);
});
test('Automatic PDF publication preserves collisions and cleans canceled/temp files', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'galpi-files-'));
  try {
    await fs.writeFile(path.join(dir,'paper.pdf'),'original');
    const files=await Promise.all([saveNewPdf(dir,'paper.pdf',Buffer.from('one')),saveNewPdf(dir,'paper.pdf',Buffer.from('two'))]);
    assert.equal(new Set(files).size,2);assert.equal(await fs.readFile(path.join(dir,'paper.pdf'),'utf8'),'original');
    assert.deepEqual((await Promise.all(files.map(f=>fs.readFile(f,'utf8')))).sort(),['one','two']);
    const ctrl=new AbortController();ctrl.abort();
    await assert.rejects(saveNewPdf(dir,'canceled.pdf',Buffer.from('none'),ctrl.signal),/abort/i);
    assert.equal((await fs.readdir(dir)).filter(f=>f.endsWith('.tmp')||f==='canceled.pdf').length,0);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
