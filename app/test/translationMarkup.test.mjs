import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
await build({entryPoints:['src/translate/translationMarkup.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist-test/translationMarkup.cjs'});
await build({entryPoints:['src/translate/trBlocks.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist-test/trBlocks.cjs'});
await build({entryPoints:['src/translate/translationContent.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist-test/translationContent.cjs'});
const require=createRequire(import.meta.url);
const {translationTokens,translationHtml,referencedFootnotes}=require('../dist-test/translationMarkup.cjs');
const {collectTrBlocks}=require('../dist-test/trBlocks.cjs');
const {translatedText,isBrokenTableText}=require('../dist-test/translationContent.cjs');

test('Translation renders four LaTeX delimiters, proper superscripts/subscripts and escaped currency',()=>{
 const source='위험 $\\alpha+\\beta R_m$ · \\(x_i^2\\) · $$\\frac{a}{b}$$ · \\[\\begin{aligned}R_t&=\\alpha\\\\V_t&=\\beta\\end{aligned}\\] 각주<sup>11</sup> H<sub>2</sub>O, 가격 \\$17.00.';
 const tokens=translationTokens(source);
 const maths=tokens.filter(t=>t.kind==='math');
 assert.equal(maths.length,4);assert.equal(maths.filter(m=>m.display).length,2);
 const html=translationHtml(source,()=> '#pdf-note-1-11');
 assert.equal((html.match(/class="pdf-math(?: pdf-math-display)?"/g)??[]).length,4);
 assert.ok(html.includes('<sup class="pdf-fn-ref"><a') && html.includes('<sub><span>2</span></sub>'));
 assert.ok(!html.includes('&lt;sup&gt;') && !html.includes('pdf-math-raw'));
 assert.ok(html.includes('$17.00'));
 assert.deepEqual(referencedFootnotes(source),['11']);
 assert.ok(translationHtml('$\\unknownMacro{a}$').includes('pdf-math-raw'));
});

test('Model HTML is not executable and only supported inline tags receive formatting',()=>{
 const html=translationHtml('<sup onclick="alert(1)">11</sup><img src=x onerror="alert(2)"><script>bad()</script>');
 assert.ok(!html.includes('onclick=') && !html.includes('<img') && !html.includes('<script'));
 assert.ok(html.includes('<sup><span>11</span></sup>'));
 assert.ok(translationHtml('&lt;sup&gt;11&lt;/sup&gt;').includes('<sup><span>11</span></sup>'));
 assert.deepEqual(referencedFootnotes('x<sub>2</sub> letter<sup>ble</sup>'),[]);
});

test('Hide only broken rotated table-side text and retain its real Korean translation',()=>{
 const blocks=[
  {id:'broken-title',type:'paragraph',page:1,bbox:[90,320,98,360],text:'<sub>a</sub><sup>ble</sup> <sup>IV</sup>'},
  {id:'broken-caption',type:'paragraph',page:1,bbox:[100,60,135,620],text:'Thetablepresentssummarystatisticsforthevariablesusedinthestudy.PanelA'},
  {id:'table',type:'table',page:1,bbox:[150,60,400,620]},
  {id:'normal',type:'paragraph',page:2,bbox:[50,50,420,190],text:'We discuss risk $R_i$ and variables H<sub>2</sub>O, with note<sup>11</sup>.'},
  {id:'caption',type:'caption',page:2,bbox:[50,195,420,230],text:'Table 2. Ordinary summary statistics.'}
 ];
 const doc={blocks,pages:[{index:1,width_pt:486},{index:2,width_pt:486}]};
 const merge={absorbed:new Set(),textOverride:new Map(),baseOf:new Map()};
 const result=collectTrBlocks(doc,{pulled:new Set(),frontIds:new Set(),frontStartId:null,merge});
 assert.ok(!result.some(b=>b.id==='broken-title'));
 const note=result.find(b=>b.id==='broken-caption');assert.equal(note.tableNote,true);
 assert.equal(translatedText(note,{ko:note.text}), '');
 assert.equal(translatedText(note,{ko:note.text+' (본 표는 표본의 요약 통계량을 보고한다.)'}),'(본 표는 표본의 요약 통계량을 보고한다.)');
 assert.ok(result.some(b=>b.id==='normal') && result.some(b=>b.id==='caption'));
 assert.equal(isBrokenTableText(blocks[3],doc),false);
 assert.equal(translatedText(result.find(b=>b.id==='normal'),{ko:'원문 인용을 포함하는 정상 번역.'}),'원문 인용을 포함하는 정상 번역.');
});
