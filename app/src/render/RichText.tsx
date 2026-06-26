// 본문 텍스트 렌더 (명세 §14-1). 두 가지를 처리:
//  1) 인라인 수식 $...$ → KaTeX inline
//  2) MinerU 가 본문에 남기는 인라인 HTML(<sup>/<sub>/<i> 등) → sanitize 후 렌더
// 그 외는 일반 텍스트. (스팬 경계 하이라이트는 텍스트 노드 단위라 영향 없음)
import { useMemo } from "react";
import katex from "katex";
import DOMPurify from "dompurify";

// $ 로 감싼 인라인 수식. \$ (이스케이프된 달러)는 제외.
const INLINE_MATH = /(?<!\\)\$(.+?)(?<!\\)\$/g;

// 비수식 구간에서 허용할 인라인 서식 태그 (각주 마커 <sup> 등).
const INLINE_HTML = {
  ALLOWED_TAGS: ["sup", "sub", "i", "b", "em", "strong", "br", "u"],
  ALLOWED_ATTR: [],
};

interface Token {
  math: boolean;
  text: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_MATH)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ math: false, text: text.slice(last, idx) });
    tokens.push({ math: true, text: m[1] });
    last = idx + m[0].length;
  }
  if (last < text.length) tokens.push({ math: false, text: text.slice(last) });
  return tokens;
}

const hasInlineHtml = (s: string) => /<\/?(sup|sub|i|b|em|strong|br|u)\b/i.test(s);

export function RichText({ text }: { text: string }) {
  const tokens = useMemo(() => tokenize(text), [text]);

  // 수식·인라인HTML 둘 다 없으면 순수 문자열(텍스트 노드 1개 → 하이라이트에 유리)
  if (tokens.length === 1 && !tokens[0].math && !hasInlineHtml(text)) return <>{text}</>;

  return (
    <>
      {tokens.map((t, i) => {
        if (t.math) {
          try {
            const html = katex.renderToString(t.text, {
              displayMode: false,
              throwOnError: true,
              strict: false,
            });
            return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
          } catch {
            return <code key={i} className="formula-raw">${t.text}$</code>;
          }
        }
        // 비수식: 인라인 HTML 있으면 sanitize 후 삽입, 없으면 일반 텍스트
        if (hasInlineHtml(t.text)) {
          const clean = DOMPurify.sanitize(t.text, INLINE_HTML);
          return <span key={i} dangerouslySetInnerHTML={{ __html: clean }} />;
        }
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}
