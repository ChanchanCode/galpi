// 수식 렌더 (명세 §7). KaTeX 우선, 실패 시 눈에 띄지 않는 경고 + 원시 LaTeX.
// LaTeX 정확도가 최우선 → 실패 블록은 needs_review 취급, Source Peek 1순위.
import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

interface Props {
  latex: string;
  display: boolean;
}

export function Formula({ latex, display }: Props) {
  const result = useMemo(() => {
    try {
      const html = katex.renderToString(latex, {
        displayMode: display,
        throwOnError: true, // 실패를 잡아 폴백 분기 (§7)
        strict: false,
      });
      return { ok: true as const, html };
    } catch {
      return { ok: false as const, html: "" };
    }
  }, [latex, display]);

  if (result.ok) {
    return (
      <span
        className={display ? "formula formula-block" : "formula formula-inline"}
        data-formula-ok="true"
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
    );
  }

  // 폴백: 작은 경고 점 + 원시 LaTeX 코드 (§7-1). 빨강 아님.
  return (
    <span className={display ? "formula-fallback formula-block" : "formula-fallback"} title="원본 보기로 확인하세요">
      <span className="formula-warn" aria-label="수식 렌더 실패">•</span>
      <code className="formula-raw">{display ? `$$${latex}$$` : `$${latex}$`}</code>
    </span>
  );
}
