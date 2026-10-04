// Full renderer + Electron PDF integration. Uses isolated data and mock AI services.
// GALPI_PLAYWRIGHT_MODULE can point to the Codex bundled playwright/index.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
const require = createRequire(import.meta.url);
const { _electron } = await import(process.env.GALPI_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.GALPI_PLAYWRIGHT_MODULE).href : 'playwright-core');
const appRoot = path.resolve(import.meta.dirname, '..');
const qaRoot = process.env.GALPI_PDF_QA_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), 'galpi-pdf-test-'));
await fs.mkdir(qaRoot, { recursive: true });
await fs.rm(path.join(qaRoot, 'data/Galpi/settings.json'), {force:true});
await build({ entryPoints: [path.join(appRoot, 'test/fixtures/pdfExportHarness.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(appRoot, 'dist-test/pdfExportHarness.cjs'), external: ['electron'] });
const options = { executablePath: require('electron'), args: [path.join(appRoot, 'dist-test/pdfExportHarness.cjs')],
  env: { ...process.env, GALPI_APP_ROOT: appRoot, GALPI_PDF_QA_ROOT: qaRoot } };
const launch = () => _electron.launch(options);
const waitReady = async (page) => {
  await page.waitForFunction(() => {
    const alert = document.querySelector('.pdf-export-footer [role=alert]');
    if (alert) throw new Error(alert.textContent);
    return document.querySelector('.pdf-export-save')?.disabled === false;
  }, { timeout: 30000 });
};
const checkLayout = async (frame, expected) => {
  const report = await frame.locator('.pdf-flow').evaluateAll((flows) => flows.map((flow) => {
    const s = getComputedStyle(flow), parent = flow.parentElement, p = getComputedStyle(parent);
    return { font: parseFloat(s.fontSize) * .75, line: parseFloat(s.lineHeight) / parseFloat(s.fontSize),
      family: s.fontFamily, top: parseFloat(p.paddingTop) * 25.4 / 96, bottom: parseFloat(p.paddingBottom) * 25.4 / 96,
      horizontal: parseFloat(p.paddingLeft) * 25.4 / 96,
      overflow: Math.max(0, flow.getBoundingClientRect().height - parent.getBoundingClientRect().height + parseFloat(p.paddingTop) + parseFloat(p.paddingBottom)),
      overflowX: flow.scrollWidth - flow.clientWidth };
  }));
  for (const flow of report) {
    assert.ok(flow.font >= Math.max(8, expected.font*.9)-.03 && flow.font <= expected.font+.03,
      `font exceeded the limited fit range: ${flow.font}`);
    for (const key of ['line', 'top', 'bottom', 'horizontal']) {
      assert.ok(Math.abs(flow[key] - expected[key]) < .03, `${key}: ${flow[key]} != ${expected[key]}`);
    }
    assert.ok(flow.overflow < 1 && flow.overflowX < 2, `clipped translation: ${JSON.stringify(flow)}`);
  }
  return report;
};
const app = await launch();
const metrics = {};
try {
  const page = await app.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const title = process.env.GALPI_PDF_REAL_DOC
    ? JSON.parse(await fs.readFile(path.join(process.env.GALPI_PDF_REAL_DOC, 'document.json'), 'utf8')).title
    : '원문 + 번역 저장 검증';
  await page.getByText(title, {exact:true}).click();
  if (!process.env.GALPI_PDF_REAL_DOC) {
    await page.getByRole('button',{name:'번역',exact:true}).click();
    const ref = page.locator('.tr-col [data-tr-for="b2"] .fn-ref');
    await ref.evaluate((el)=>el.click());
    await page.getByRole('dialog',{name:'원문 각주 11',exact:true}).waitFor();
    assert.ok((await page.locator('.fn-pop').innerText()).includes('Synthetic original footnote'));
    assert.equal(await page.locator('.fn-pop .katex').count(),1);
    assert.equal(await page.locator('.rd-canvas .fn-pop').count(),0);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'원본 모드',exact:true}).click();
    await page.waitForFunction(()=>{
      const sc=document.querySelector('.reader-scroll').getBoundingClientRect();
      const image=document.querySelector('.src-canvas .spread[data-page="1"] svg, .src-canvas .spread[data-page="1"] img');
      if (!image || (image.tagName.toLowerCase()==='img' && !image.naturalWidth)) return false;
      const rect=image.getBoundingClientRect();
      return rect.top<sc.bottom && rect.bottom>sc.top && getComputedStyle(document.querySelector('.rd-canvas')).display==='none';
    });
    await page.getByRole('button',{name:'원본 모드',exact:true}).click();
    await page.getByRole('button',{name:'원본 모드',exact:true}).click();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.rd-canvas')).display==='none'
      && !!document.querySelector('.src-canvas .spread[data-page="1"] svg, .src-canvas .spread[data-page="1"] img'));
    for (let i=0;i<2;i++) {
      await page.getByRole('button',{name:'번역',exact:true}).click();
      await page.getByRole('button',{name:'원본 모드',exact:true}).click();
      await page.getByRole('button',{name:'원본 모드',exact:true}).click();
      await page.waitForFunction(()=>{
        const art=document.querySelector('.src-canvas .pagehalf svg, .src-canvas .pagehalf img');
        return art && art.getBoundingClientRect().width>100 && getComputedStyle(document.querySelector('.rd-canvas')).display==='none';
      });
    }
    await page.locator('.src-canvas [data-tr-for="b2"] .fn-ref').evaluate((el)=>el.click());
    await page.getByRole('dialog',{name:'원문 각주 11',exact:true}).waitFor();
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', {name:'내보내기',exact:true}).click();
  await waitReady(page);
  metrics.fillCalls = await app.evaluate(()=>globalThis.fillCalls??[]);
  if (!process.env.GALPI_PDF_REAL_DOC) assert.deepEqual(metrics.fillCalls,[['b3']]);
  const frame = page.frameLocator('iframe[title="PDF 저장 미리보기"]');
  await page.getByRole('button', {name:'기본 배치로 초기화',exact:true}).click();
  await waitReady(page);
  metrics.base = await checkLayout(frame, {font:11.5,line:1.7,top:6,bottom:6,horizontal:4});
  metrics.basePages = await frame.locator('.pdf-sheet').count();
  const printedText=(await frame.locator('.pdf-flow').allTextContents()).join('');
  assert.ok(!printedText.includes('<sup>') && !printedText.includes('<sub>'));
  assert.ok(!printedText.includes('[아직 번역되지 않은 문단]'));
  if (!process.env.GALPI_PDF_REAL_DOC) {
    assert.equal(await frame.locator('.pdf-sheet[data-source-page="2"] .pdf-math').count(),5);
    assert.equal(await frame.locator('.pdf-sheet[data-source-page="2"] .pdf-math-display').count(),2);
    assert.equal(await frame.locator('.pdf-math-raw').count(),0);
    assert.equal(await frame.locator('#pdf-note-2-11').count(),1);
    await frame.locator('.pdf-fn-ref a').click();
    assert.equal(await frame.locator('#pdf-note-2-11.flash').count(),1);
  } else if (title==='Do ETFs Increase Volatility?') {
    assert.equal(await frame.locator('.pdf-sheet[data-source-page="12"] .pdf-table-note').count(),0);
    const note=await frame.locator('.pdf-sheet[data-source-page="24"] .pdf-table-note').innerText();
    assert.ok(note.includes('본 표는 ETF 보유 지분율'));
    assert.ok(!note.includes('themeananddividing') && !note.includes('Thetablereportsestimates'));
    assert.equal(await frame.locator('#pdf-note-18-11').count(),1);
  }
  await page.screenshot({path:path.join(qaRoot,'preview-default.png')});
  if (!process.env.GALPI_PDF_REAL_DOC) {
    const text = (await frame.locator('.pdf-flow').allTextContents()).join('');
    for (let i=1;i<=200;i++) assert.ok(text.includes(`문장${i}:`), `missing sentence ${i}`);
    assert.equal(await frame.locator('body').evaluate(() => window.__injected), undefined);
    assert.ok(metrics.basePages > 3);
    const affected = frame.locator('.pdf-sheet[data-source-page="4"]');
    assert.equal(await affected.count(),1);
    metrics.minorFitFont = await affected.getAttribute('data-font-size');
    assert.equal(Number(metrics.minorFitFont),11.1);
    const regular = await frame.locator('.pdf-sheet:not([data-source-page="4"]) .pdf-flow').evaluateAll((flows)=>flows.map((f)=>parseFloat(getComputedStyle(f).fontSize)*.75));
    assert.ok(regular.every((font)=>Math.abs(font-11.5)<.01));
    await page.getByLabel('살짝 넘치는 쪽만 글자 크기 줄이기', {exact:true}).uncheck(); await waitReady(page);
    assert.equal(await affected.count(),2);
    await page.getByLabel('살짝 넘치는 쪽만 글자 크기 줄이기', {exact:true}).check(); await waitReady(page);
    assert.equal(await affected.count(),1);
    await page.getByLabel('미리보기 페이지',{exact:true}).selectOption(String(metrics.basePages));
    await page.screenshot({path:path.join(qaRoot,'preview-minor-fit.png')});
  }
  await page.getByLabel('번역 글자 크기', {exact:true}).fill('16');
  await page.getByLabel('번역 줄간격', {exact:true}).fill('2.2');
  await page.getByLabel('번역 위 여백', {exact:true}).fill('14');
  await page.getByLabel('번역 아래 여백', {exact:true}).fill('10');
  await page.getByLabel('번역 좌우 여백', {exact:true}).fill('7');
  await page.getByLabel('번역 글꼴', {exact:true}).selectOption({label:'명조 · 시스템'});
  await waitReady(page);
  metrics.changed = await checkLayout(frame, {font:16,line:2.2,top:14,bottom:10,horizontal:7});
  assert.ok(metrics.changed.every((f) => f.family.includes('AppleMyungjo')));
  metrics.changedPages = await frame.locator('.pdf-sheet').count();
  assert.ok(metrics.changedPages > metrics.basePages);
  await page.screenshot({path:path.join(qaRoot,'preview-adjusted.png')});
  // Changing settings must keep the current source page even when page counts change.
  const map = await frame.locator('.pdf-sheet').evaluateAll((s) => s.map((el) => Number(el.dataset.sourcePage)));
  const lastSource = map.at(-1);
  await page.getByLabel('미리보기 페이지', {exact:true}).selectOption(String(map.length));
  await page.getByLabel('종이 바깥 여백', {exact:true}).fill('12');
  await page.getByLabel('원문과 번역 사이', {exact:true}).fill('10');
  await waitReady(page);
  const selectedSource = await page.getByLabel('미리보기 페이지', {exact:true}).evaluate((select) => select.selectedOptions[0].textContent);
  assert.match(selectedSource, new RegExp(`원문 ${lastSource}쪽`));
  // Check zoom independently of physical layout and verify the selected sheet is aligned.
  for (const zoom of ['100', '125', 'fit']) {
    await page.getByLabel('미리보기 확대', {exact:true}).selectOption(zoom);
    await checkLayout(frame, {font:16,line:2.2,top:14,bottom:10,horizontal:7});
  }
  const position = await frame.locator('.pdf-sheet').evaluateAll((s) => s.map((el) => el.getBoundingClientRect().top));
  const selected = Number(await page.getByLabel('미리보기 페이지', {exact:true}).inputValue());
  assert.ok(Math.abs(position[selected-1]) < 1);
  // Numeric entry can be cleared/replaced before committing on blur.
  const number = page.getByLabel('번역 글자 크기 값', {exact:true});
  await number.fill('12.5'); await number.press('Tab'); await waitReady(page);
  await checkLayout(frame, {font:12.5,line:2.2,top:14,bottom:10,horizontal:7});
  if (!process.env.GALPI_PDF_REAL_DOC) {
    await page.getByLabel('PDF 용지', {exact:true}).selectOption('a4');
    await page.getByLabel('번역 칸 폭', {exact:true}).fill('35');
    await page.getByLabel('번역 좌우 여백', {exact:true}).fill('20');
    await waitReady(page);
    await checkLayout(frame, {font:12.5,line:2.2,top:14,bottom:10,horizontal:20});
    const narrowText = (await frame.locator('.pdf-flow').allTextContents()).join('');
    for (let i=1;i<=200;i++) assert.ok(narrowText.includes(`문장${i}:`));
  }
  // Save a readable representative layout, using the actual dialog and PDF path.
  await page.getByRole('button', {name:'기본 배치로 초기화',exact:true}).click(); await waitReady(page);
  await page.getByLabel('번역 글꼴', {exact:true}).selectOption({label:'고딕 · 시스템'}); await waitReady(page);
  await page.getByLabel('미리보기 페이지', {exact:true}).selectOption('1');
  metrics.savedMap = await frame.locator('.pdf-sheet').evaluateAll((s) => s.map((el) => Number(el.dataset.sourcePage)));
  await page.getByRole('button', {name:'PDF 저장',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden',timeout:60000});
  metrics.savedFilename = path.basename(await app.evaluate(()=>globalThis.lastSaveDefault));
  if (!process.env.GALPI_PDF_REAL_DOC) assert.equal(metrics.savedFilename,'Lovelace & Turing (2026) - 원문 + 번역 저장 검증 - 원문+번역.pdf');
  else if (title === 'Do ETFs Increase Volatility?') assert.equal(metrics.savedFilename,'Ben-David et al. (2018) - Do ETFs Increase Volatility - 원문+번역.pdf');
  const bytes = await fs.readFile(path.join(qaRoot,'bilingual.pdf'));
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), metrics.savedMap.length);
  assert.ok(Math.abs(pdf.getPage(0).getWidth() - 420*72/25.4) < .1);
  await page.getByRole('button', {name:'내보내기',exact:true}).click(); await waitReady(page);
  assert.equal(await page.getByLabel('번역 글꼴', {exact:true}).inputValue(), '"Apple SD Gothic Neo", "Malgun Gothic", sans-serif');
  // Cancel and failed exports must preserve the already saved destination.
  await app.evaluate(({dialog}) => { dialog.showSaveDialog = async () => ({canceled:true}); });
  await page.getByRole('button', {name:'PDF 저장',exact:true}).click(); await waitReady(page);
  assert.deepEqual(await fs.readFile(path.join(qaRoot,'bilingual.pdf')), bytes);
  await app.evaluate(({dialog}, qaRoot) => { dialog.showSaveDialog = async () => ({canceled:false,filePath:qaRoot+'/bilingual.pdf'}); }, qaRoot);
  const source = path.join(qaRoot,'data/Galpi/docs/pdf-qa/source.pdf');
  await fs.rename(source, source+'.backup');
  await page.getByRole('button', {name:'PDF 저장',exact:true}).click();
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await fs.readFile(path.join(qaRoot,'bilingual.pdf')), bytes);
  await fs.rename(source+'.backup', source);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(qaRoot,'metrics.json'),JSON.stringify(metrics,null,2));
  console.log(JSON.stringify({qaRoot,basePages:metrics.basePages,changedPages:metrics.changedPages,savedPages:metrics.savedMap.length,
    minorFitFont:metrics.minorFitFont,savedFilename:metrics.savedFilename,selectedMarginsAndLineHeightPreserved:true,overflow:0,cancelAndFailurePreserveFile:true},null,2));
} catch (error) {
  try { await (await app.firstWindow()).screenshot({path:path.join(qaRoot,'failure.png')}); } catch {}
  throw error;
} finally { await app.close(); }
const restarted = await launch();
try {
  const page = await restarted.firstWindow();
  await page.getByText('다른 논문 기본값 검증', {exact:true}).click();
  await page.getByRole('button', {name:'내보내기',exact:true}).click(); await waitReady(page);
  assert.equal(await page.getByLabel('번역 글자 크기', {exact:true}).inputValue(),'11.5');
  assert.equal(await page.getByLabel('번역 위 여백', {exact:true}).inputValue(),'6');
  assert.match(await page.getByLabel('번역 글꼴', {exact:true}).inputValue(),/Apple SD Gothic Neo/);
  assert.equal(await page.getByLabel('살짝 넘치는 쪽만 글자 크기 줄이기',{exact:true}).isChecked(),true);
  console.log('Settings restored in another paper after a complete Electron restart.');
} finally { await restarted.close(); }
