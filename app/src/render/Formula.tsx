// 수식 렌더 (명세 §7). KaTeX 우선, 실패 시 눈에 띄지 않는 경고 + 원시 LaTeX.
// LaTeX 정확도가 최우선 → 실패 블록은 needs_review 취급, Source Peek 1순위.
import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

interface Props {
  latex: string;
  display: boolean;
}

// 식 번호 \tag{N} / \tag*{N} 분리. KaTeX가 넓은 식에서 번호를 본문과 겹쳐 그리는
// 문제를 피하려고, 번호를 수식에서 떼어내 별도 오른쪽 라벨로 렌더한다.
const TAG_RE = /\\tag(\*)?\s*\{([^}]*)\}/;

function splitTag(latex: string): { body: string; tag: string | null } {
  const m = latex.match(TAG_RE);
  if (!m) return { body: latex, tag: null };
  const star = !!m[1];
  const content = m[2];
  const body = latex.replace(TAG_RE, "").trim();
  return { body, tag: star ? content : `(${content})` }; // \tag 는 괄호 자동(amsmath)
}

function renderKatex(latex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: false });
  } catch {
    return null;
  }
}

export function Formula({ latex, display }: Props) {
  const { body, tag } = useMemo(() => (display ? splitTag(latex) : { body: latex, tag: null }), [latex, display]);
  const html = useMemo(() => renderKatex(body, display), [body, display]);

  // 폴백: 작은 경고 점 + 원시 LaTeX (§7-1). 빨강 아님.
  if (html === null) {
    return (
      <span className={display ? "formula-fallback formula-block" : "formula-fallback"} title="원본 보기로 확인하세요">
        <span className="formula-warn" aria-label="수식 렌더 실패">•</span>
        <code className="formula-raw">{display ? `$$${latex}$$` : `$${latex}$`}</code>
      </span>
    );
  }

  if (!display) {
    return <span className="formula formula-inline" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // block: [번호 자리(좌, 균형용)] [수식(가운데, 넓으면 가로스크롤)] [번호(우)]
  return (
    <div className="eq-row">
      <span className="eq-side" aria-hidden="true">{tag ?? ""}</span>
      <span className="eq-body" dangerouslySetInnerHTML={{ __html: html }} />
      <span className="eq-side eq-num">{tag ?? ""}</span>
    </div>
  );
}
