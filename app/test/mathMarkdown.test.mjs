// mathMarkdown.ts 결정적 검증 — AI 답변의 Markdown + LaTeX 가 깨지지 않는지(DOM 없이 HTML 문자열로).
// 실행: npm test  (node .p2build.mjs 가 dist-test/mathMarkdown.cjs 를 만든다)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderMarkdown, citeIds } = require(path.join(import.meta.dirname, "..", "dist-test", "mathMarkdown.cjs"));

const count = (s, needle) => s.split(needle).length - 1;
const r = (src, streaming = false) => renderMarkdown(src, { streaming });

test("인라인 수식 → KaTeX, 구분자 안 남음", () => {
  const h = r("값 $x^2$ 이다");
  assert.equal(count(h, 'class="math-inline"'), 1);
  assert.match(h, /class="katex"/);
  assert.ok(!h.includes("$"), h);
});

test("블록 수식 $$ → katex-display", () => {
  const h = r("앞 문단\n\n$$\n\\int_0^1 f(x)\\,dx\n$$\n\n뒤 문단");
  assert.equal(count(h, 'class="math-display"'), 1);
  assert.match(h, /katex-display/);
  assert.match(h, /<p>앞 문단<\/p>/);
  assert.match(h, /<p>뒤 문단<\/p>/);
});

test("\\( \\) · \\[ \\] 지원", () => {
  const h = r("인라인 \\(a+b\\) 과 블록 \\[c = d\\]");
  assert.equal(count(h, 'class="math-inline"'), 1);
  assert.equal(count(h, 'class="math-display"'), 1);
  assert.ok(!h.includes("\\("), h);
  assert.ok(!h.includes("\\["), h);
});

test("코드 속 $ 와 인용은 그대로", () => {
  const h = r("셸 `echo $HOME $PATH` 와 [b0001]\n\n```sh\nexport A=$x$ # [b0002]\n```");
  assert.match(h, /<code>echo \$HOME \$PATH<\/code>/);
  assert.match(h, /<code class="language-sh">export A=\$x\$ # \[b0002\]<\/code>/);
  assert.ok(!h.includes('data-block="b0002"'), h);
  assert.match(h, /data-block="b0001"/);
  assert.ok(!h.includes("katex"), h);
});

test("들여쓰기 코드블록 안 수식도 원문으로 복원", () => {
  const h = r("    y = $x$ + 1");
  assert.match(h, /<pre><code>y = \$x\$ \+ 1<\/code><\/pre>/);
  assert.ok(!h.includes("katex"), h);
});

test("통화 — $5 and $10 · $5-$10 · $1,000 and $2,000 · \\$", () => {
  for (const s of ["costs $5 and $10 today", "range $5-$10 wide", "$1,000 and $2,000", "earned $5 million while x$"]) {
    const h = r(s);
    assert.ok(!h.includes("katex"), `${s} → ${h}`);
    assert.ok(h.includes("$"), h);
  }
  const e = r("escaped \\$5 and $y$");
  assert.match(e, /escaped \$5 and <span class="math-inline">/);
});

test("통화와 수식이 섞여도 수식만 잡는다", () => {
  const h = r("between $5 and $x$ here");
  assert.equal(count(h, 'class="math-inline"'), 1);
  assert.match(h, /between \$5 and <span/);
});

test("밑줄·별표가 Markdown 강조로 먹히지 않는다", () => {
  const h = r("$a_1 * b_2$ 와 $c_3 * d_4$ 그리고 $x_{i}$ 와 $y_{j}$");
  assert.ok(!h.includes("<em>"), h);
  assert.ok(!h.includes("<strong>"), h);
  assert.equal(count(h, 'class="math-inline"'), 4);
});

test("한글에 붙은 수식 · 뒤 하이픈", () => {
  const h = r("값$x$는 $n$-th 항");
  assert.equal(count(h, 'class="math-inline"'), 2);
});

test("표 — 셀 안 $|x|$ 의 | 가 셀을 가르지 않는다", () => {
  const h = r("| 식 | 근거 |\n|---|---|\n| $|x| + 1$ | [b0042] |\n| a | b |");
  assert.match(h, /<table>/);
  const firstRow = h.split("<tbody>")[1].split("</tr>")[0];
  assert.equal(count(firstRow, "<td"), 2, firstRow);
  assert.match(firstRow, /math-inline/);
  assert.match(firstRow, /data-block="b0042"/);
});

test("인용 [b0042] · [b0042, b0051] · 세미콜론", () => {
  const h = r("결과 [b0042] 와 [b0042, b0051] 및 [b0123; b0124]");
  assert.equal(count(h, 'class="cite"'), 3);
  assert.equal(count(h, 'data-blocks="b0042 b0051"'), 1);
  assert.equal(count(h, 'data-blocks="b0123 b0124"'), 1);
  // 공백만 사이에 둔 묶음은 칩 하나로 합친다
  const g = r("수치 [b0042] [b0043, b0042]");
  assert.equal(count(g, 'class="cite"'), 1, g);
  assert.equal(count(g, 'data-blocks="b0042 b0043"'), 1, g);
  assert.ok(!h.includes("[b0"), h);
  assert.deepEqual(citeIds("[b0042, b0051] [b0042]"), ["b0042", "b0051"]);
});

test("인용 아닌 대괄호는 그대로", () => {
  const h = r("[a] [b12] [b0042x]");
  assert.ok(!h.includes('class="cite"'), h);
});

test("스트리밍 — 닫히지 않은 $$ 는 원문 스팬(깨진 KaTeX 없음)", () => {
  const h = r("스트리밍 $$\\frac{a}{", true);
  assert.match(h, /class="math-raw math-display math-pending"/);
  assert.ok(!h.includes("katex"), h);
  // 끝나면(스트리밍 아님) 미종결 $$ 는 글자 그대로
  const done = r("끝 $$\\frac{a}{");
  assert.ok(!done.includes("math-"), done);
  assert.match(done, /\$\$/);
});

test("스트리밍 — 닫히지 않은 코드펜스는 임시로 닫힌다", () => {
  const h = r("앞\n\n```python\nprint($x$)\n", true);
  assert.match(h, /<pre><code class="language-python">print\(\$x\$\)<\/code><\/pre>/);
  assert.ok(!h.includes("katex"), h);
  assert.ok(!h.includes("```"), h);
});

test("스트리밍 — 반쯤 온 인라인 $ 는 글자로", () => {
  const h = r("값 $x^", true);
  assert.ok(!h.includes("katex"), h);
  assert.match(h, /\$x\^/);
});

test("KaTeX 오류 → 이스케이프된 원문, katex-error 없음", () => {
  const h = r("bad $\\notacommand{<b>}$ end");
  assert.match(h, /<span class="math-raw">\$\\notacommand\{&lt;b&gt;\}\$<\/span>/);
  assert.ok(!h.includes("katex-error"), h);
  assert.ok(!h.includes("<b>"), h);
});

test("\\label 은 떼고 렌더", () => {
  const h = r("$$x = 1 \\label{eq:1}$$");
  assert.match(h, /katex-display/);
  assert.ok(!h.includes("math-raw"), h);
});

test("속성 안(alt) 수식은 원문으로 — 태그가 깨지지 않는다", () => {
  const h = r("![$x$](a.png)");
  assert.match(h, /alt="\$x\$"/);
  assert.ok(!/alt="[^"]*<span/.test(h), h);
});

test("자리표시자 위조 문자는 지워진다", () => {
  const pua = String.fromCharCode(0xe000) + "0" + String.fromCharCode(0xe001);
  const h = r(`가짜 ${pua} 진짜 $y$`);
  assert.equal(count(h, 'class="math-inline"'), 1);
  assert.ok(!h.includes(String.fromCharCode(0xe000)), h);
});

test("목록 안 블록 수식 · 제목 속 수식 · \\\\[2pt] 는 수식 아님", () => {
  const h = r("## 모형 $\\beta$\n\n- 항목\n  $$\n  a = b\n  $$\n- 둘\n\n줄바꿈 \\\\[2pt] 뒤");
  assert.match(h, /<h2>모형 <span class="math-inline">/);
  assert.match(h, /<li>항목\s*<span class="math-display">/);
  assert.match(h, /\\\[2pt\]/);
});

test("코드블록 복사 버튼 · 언어 라벨", () => {
  const h = r("```js\nconst a = 1;\n```");
  assert.match(h, /class="md-copy"/);
  assert.match(h, /<span class="md-lang">js<\/span>/);
});

test("빈 입력", () => {
  assert.equal(r(""), "");
  assert.equal(r("   \n "), "");
});
