// 본문 텍스트 렌더 (명세 §14-1). 세 가지를 처리:
//  1) 인라인 수식 $...$ → KaTeX inline
//  2) 각주 참조 <sup>라벨</sup> 이 각주 맵에 있으면 → 클릭형 FootnoteRef
//  3) 그 외 인라인 HTML(<sub>/<i> 등) → sanitize 후 렌더
import { useContext, useMemo } from "react";
import katex from "katex";
import DOMPurify from "dompurify";
import { FootnoteContext } from "./footnotes";
import { FootnoteRef } from "./FootnoteRef";

// $...$ (인라인 수식) 또는 <sup>...</sup> 를 토큰 경계로.
const TOKEN = /(?<!\\)\$(.+?)(?<!\\)\$|<sup>(.+?)<\/sup>/gi;
const INLINE_HTML = {
  ALLOWED_TAGS: ["sup", "sub", "i", "b", "em", "strong", "br", "u"],
  ALLOWED_ATTR: [],
};

type Tok =
  | { kind: "text"; text: string }
  | { kind: "math"; text: string }
  | { kind: "sup"; text: string };

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) toks.push({ kind: "text", text: text.slice(last, idx) });
    if (m[1] !== undefined) toks.push({ kind: "math", text: m[1] });
    else toks.push({ kind: "sup", text: m[2] });
    last = idx + m[0].length;
  }
  if (last < text.length) toks.push({ kind: "text", text: text.slice(last) });
  return toks;
}

const hasInlineHtml = (s: string) => /<\/?(sup|sub|i|b|em|strong|br|u)\b/i.test(s);

export function RichText({ text }: { text: string }) {
  const footnotes = useContext(FootnoteContext);
  const toks = useMemo(() => tokenize(text), [text]);

  // 수식·sup·인라인HTML 전혀 없으면 순수 문자열(텍스트 노드 1개 → 하이라이트에 유리)
  if (toks.length === 1 && toks[0].kind === "text" && !hasInlineHtml(text)) return <>{text}</>;

  return (
    <>
      {toks.map((t, i) => {
        if (t.kind === "math") {
          try {
            const html = katex.renderToString(t.text, { displayMode: false, throwOnError: true, strict: false });
            return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
          } catch {
            return <code key={i} className="formula-raw">${t.text}$</code>;
          }
        }
        if (t.kind === "sup") {
          const note = footnotes.get(t.text.trim());
          if (note) return <FootnoteRef key={i} note={note} />;
          return <sup key={i}>{t.text}</sup>;
        }
        if (hasInlineHtml(t.text)) {
          const clean = DOMPurify.sanitize(t.text, INLINE_HTML);
          return <span key={i} dangerouslySetInnerHTML={{ __html: clean }} />;
        }
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}
