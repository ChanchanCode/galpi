import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
await build({entryPoints:['src/render/footnotes.ts','src/render/footnoteSource.ts','src/translate/trBlocks.ts','src/translate/translationContent.ts','electron/ai/paperContext.ts'],
  outdir:'dist-test/footnote-tests',outbase:'.',bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'}});
const require = createRequire(import.meta.url);
const {buildFootnotes} = require('../dist-test/footnote-tests/src/render/footnotes.cjs');
const {recoverFootnoteSource} = require('../dist-test/footnote-tests/src/render/footnoteSource.cjs');
const {collectTrBlocks} = require('../dist-test/footnote-tests/src/translate/trBlocks.cjs');
const {translatedText} = require('../dist-test/footnote-tests/src/translate/translationContent.cjs');
const {hiddenSets} = require('../dist-test/footnote-tests/electron/ai/paperContext.cjs');
const block = (id,text,type='footnote',page=1,bbox=null) => ({id,text,type,page,bbox});

test('Plain, superscript and merged definitions have independent labels and cache identities',()=>{
  const notes=buildFootnotes([block('a','5 First note.'),block('b','<sup>6</sup> Second note.'),
    block('c','7 Third note.\n8 Fourth note. <sup>9</sup> Fifth note.'),block('d','<sup>10</sup>No gap. <sup>11</sup>Next note.')]);
  assert.deepEqual(notes.ordered.map(n=>n.label),['5','6','7','8','9','10','11']);
  assert.equal(notes.byLabel.get('7').html,'Third note.');
  assert.equal(notes.byLabel.get('8').html,'Fourth note.');
  assert.equal(notes.byLabel.get('10').html,'No gap.');
  assert.equal(new Set(notes.ordered.map(n=>n.id)).size,7);
});

test('Body text ends implicit continuation; ordinary digits and scientific superscripts are preserved',()=>{
  const notes=buildFootnotes([block('n','<sup>6</sup> Tax efficient.'),block('body','Next page body.','paragraph',2),
    block('orphan','A different unlabelled note.','footnote',2),block('list','7 Items in a list.','list'),
    block('math','<sup>x</sup> Variable at the start.','paragraph')]);
  assert.equal(notes.byLabel.get('6').html,'Tax efficient.');
  assert.deepEqual([...notes.pulled],['n']);
});

test('Continuation preserves spaces and dehyphenates only an explicit cut word',()=>{
  const notes=buildFootnotes([block('a','1 Future income'),block('b','account.'),block('c','2 Invest-'),block('d','ment.')]);
  assert.equal(notes.byLabel.get('1').html,'Future income account.');
  assert.equal(notes.byLabel.get('2').html,'Investment.');
});

function fixture() {
  const doc={doc_id:'notes',title:'Footnote regression',pages:[{index:1,width_pt:430,height_pt:650},{index:2,width_pt:430,height_pt:650}],blocks:[
    block('body1','The body refers to notes.<sup>5</sup><sup>6</sup><sup>7</sup>','paragraph',1,[60,50,380,100]),
    block('n5','5 Models and studies.','footnote',1,[55,475,380,510]),
    block('n6','<sup>6</sup> More tax efficient.','footnote',1,[55,520,380,540]),
    block('n7','7 Funds are associated with','footnote',1,[55,545,380,580]),
    block('body2','The next page contains real body text.<sup>8</sup>','paragraph',2,[60,50,380,110]),
    block('continued7','future income accounts. Investors avoid tapping these accounts.','paragraph',2,[60,410,380,480]),
    block('n8','8 Securities regulation.','footnote',2,[55,485,380,525]),
    block('n9','Smart beta funds form a category.','footnote',2,[55,530,380,560]),
    block('n10','<sup>10</sup> Further studies.','footnote',2,[55,565,380,580]),
  ]};
  const line=(y,t,h=7)=>({x:60,y,w:310,h,t});
  const sources=new Map([[2,{w:430,h:650,lines:[
    line(52,'The next page contains real body text.',10),line(70,'Other words from the body of the paper.',10),
    line(412,'future income accounts.'),line(425,'Investors avoid tapping these accounts.'),
    line(487,'8 Securities regulation.',9),line(532,'9 Smart beta funds form a category.',9),line(567,'10 Further studies.',9),
  ]}]]);
  return {doc,sources};
}

test('Source evidence restores a dropped label and continued note after intervening body paragraphs',()=>{
  const {doc,sources}=fixture();
  const before=structuredClone(doc);
  const recovered=recoverFootnoteSource(doc,sources),notes=buildFootnotes(recovered.blocks);
  assert.deepEqual(doc,before); // Pure repair must not alter extraction/state files.
  assert.deepEqual(notes.ordered.map(n=>n.label),['5','6','7','8','9','10']);
  assert.deepEqual(notes.byLabel.get('7').sourceIds,['n7','continued7']);
  assert.equal(notes.byLabel.get('7').html,'Funds are associated with future income accounts. Investors avoid tapping these accounts.');
  assert.equal(notes.byLabel.get('9').html,'Smart beta funds form a category.');
  assert.ok(!notes.byLabel.get('6').html.includes('Securities'));
  assert.ok(!notes.pulled.has('body2'));
});

test('A full-size lower body paragraph or a mismatched source line is never reassigned',()=>{
  const {doc,sources}=fixture();
  sources.get(2).lines.filter(l=>l.y>=410 && l.y<480).forEach(l=>l.h=10);
  sources.get(2).lines.find(l=>l.y===532).t='9 An unrelated column of the page.';
  const recovered=recoverFootnoteSource(doc,sources);
  assert.equal(recovered.blocks.find(b=>b.id==='continued7').type,'paragraph');
  assert.equal(recovered.blocks.find(b=>b.id==='n9').footnote_label,undefined);
});

test('Translation includes each complete note once, including notes the model omitted from its body output',()=>{
  const {doc,sources}=fixture();
  const repaired=recoverFootnoteSource(doc,sources),h=hiddenSets(repaired.blocks);
  const blocks=collectTrBlocks(repaired,{pulled:h.footnotes.pulled,frontIds:h.frontMatter.ids,frontStartId:h.frontMatter.startId,merge:h.merge});
  const notes=blocks.filter(b=>b.kind==='footnote');
  assert.deepEqual(notes.map(b=>b.footnoteLabel),['5','6','7','8','9','10']);
  assert.deepEqual(blocks.filter(b=>b.kind!=='footnote').map(b=>b.id),['body1','body2']);
  assert.match(notes.find(b=>b.footnoteLabel==='7').text,/future income accounts/);
  assert.equal(notes.find(b=>b.footnoteLabel==='7').page,1);
  assert.equal(translatedText(notes[0],{ko:notes[0].text}),'');
  assert.equal(translatedText(notes[0],{ko:'모형과 연구를 참조한다.'}),'모형과 연구를 참조한다.');
});
