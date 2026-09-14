// 번역 텍스트 렌더 — 인라인 수식만 KaTeX 로 그린다.
//
// 번역 결과에는 원문의 `$...$` 가 **글자 그대로** 살아 있다(§5 규칙 3 + segment.ts 의 복원).
// 그대로 두면 카드에 `$\alpha_{s}$` 가 노출된다.
//
// 본문의 RichText 를 쓰지 않는 이유: 그쪽은 각주 참조·상호참조·읽기보조까지 얹는데,
// 번역문에는 그 앵커가 없다(각주 번호는 원문 쪽에만 있다). 수식만 필요하다.
import { memo, useMemo } from "react";
import katex from "katex";

// D22 — 파이프라인·RichText·segment 와 **같은 패턴**이어야 한다.
// 안 맞추면 `\$17.00` 같은 실데이터에서 산문을 수식으로 먹는다.
const MATH = /(?<!\\)\$(.+?)(?<!\\)\$/g;

interface Tok {
  math: boolean;
  text: string;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ math: false, text: text.slice(last, i) });
    out.push({ math: true, text: m[1] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ math: false, text: text.slice(last) });
  return out;
}

// 같은 수식이 카드 수백 장에 반복된다($\beta$ 등). 렌더마다 KaTeX 를 다시 돌리지 않게 모듈 캐시.
const mathCache = new Map<string, string | null>();
function mathHtml(tex: string): string | null {
  let html = mathCache.get(tex);
  if (html !== undefined) return html;
  try {
    html = katex.renderToString(tex, { displayMode: false, throwOnError: true, strict: false });
  } catch {
    html = null; // 깨진 LaTeX 는 원문 그대로 보여 준다 — 조용히 지우지 않는다
  }
  if (mathCache.size > 4000) mathCache.clear();
  mathCache.set(tex, html);
  return html;
}

export const TrText = memo(function TrText({ text }: { text: string }) {
  const toks = useMemo(() => tokenize(text), [text]);
  // 수식이 없으면 문자열 하나로 — 텍스트 노드가 쪼개지지 않아야 호버 정렬이 편하다.
  if (toks.length === 1 && !toks[0].math) return <>{text}</>;
  return (
    <>
      {toks.map((t, i) => {
        if (!t.math) return <span key={i}>{t.text}</span>;
        const html = mathHtml(t.text);
        return html ? (
          <span key={i} className="tr-math" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span key={i} className="tr-math-raw">${t.text}$</span>
        );
      })}
    </>
  );
});
