// 본문 텍스트 렌더 (명세 §14-1). 처리 항목:
//  1) 인라인 수식 $...$ → KaTeX inline
//  2) 각주 참조 <sup>라벨</sup> → 클릭형 FootnoteRef
//  3) 그 외 인라인 HTML(<sub>/<i> 등) → sanitize 후 렌더
//  4) 상호참조(Figure/Eq./Proposition…) → RefLink (호버 프리뷰·클릭 이동)
//  5) 읽기 보조: Bionic Reading · 문장 끝 줄바꿈 (평문 조각에만)
import { useContext, useMemo, Fragment, type ReactNode } from "react";
import katex from "katex";
import DOMPurify from "dompurify";
import { FootnoteContext } from "./footnotes";
import { FootnoteRef } from "./FootnoteRef";
import { CrossRefContext, findMentions, hasResolvableMention, type RefTarget } from "./crossrefs";
import { RefLink } from "./RefLink";
import { ReadingContext, renderReading } from "./reading";

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

// 평문 토큰: 상호참조로 쪼개고, 참조 아닌 조각엔 읽기 보조(Bionic·문장 줄바꿈) 적용.
function renderPlain(
  text: string,
  index: Map<string, RefTarget>,
  reading: { bionic: boolean; sentenceBreak: boolean },
  keyBase: string,
): ReactNode {
  const mentions = findMentions(text, index);
  if (!mentions.length) return <>{renderReading(text, reading, keyBase)}</>;
  const out: ReactNode[] = [];
  let last = 0;
  mentions.forEach((mn, i) => {
    if (mn.start > last) out.push(...renderReading(text.slice(last, mn.start), reading, `${keyBase}p${i}`));
    out.push(<RefLink key={`${keyBase}r${i}`} targetKey={mn.key} label={mn.label} />);
    last = mn.end;
  });
  if (last < text.length) out.push(...renderReading(text.slice(last), reading, `${keyBase}pz`));
  return <>{out}</>;
}

export function RichText({ text }: { text: string }) {
  const footnotes = useContext(FootnoteContext);
  const { index } = useContext(CrossRefContext);
  const reading = useContext(ReadingContext);
  const toks = useMemo(() => tokenize(text), [text]);

  // 변환할 게 전혀 없으면 순수 문자열(텍스트 노드 1개 → 하이라이트/검색에 유리)
  if (
    toks.length === 1 &&
    toks[0].kind === "text" &&
    !hasInlineHtml(text) &&
    !reading.bionic &&
    !reading.sentenceBreak &&
    !hasResolvableMention(text, index)
  )
    return <>{text}</>;

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
        return <Fragment key={i}>{renderPlain(t.text, index, reading, String(i))}</Fragment>;
      })}
    </>
  );
}
