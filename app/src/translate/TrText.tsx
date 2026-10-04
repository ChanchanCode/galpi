// Translation markup shares the PDF parser: safe formatting, math and note markers.
import { Fragment, memo, useContext, useMemo, type ReactNode } from "react";
import { FootnoteContext } from "../render/footnoteContext";
import { FootnoteRef } from "../render/FootnoteRef";
import { footnoteLabel, translationMathHtml, translationTokens, type TranslationToken } from "./translationMarkup";

export const TrText = memo(function TrText({ text, linkFootnotes = true }: { text: string; linkFootnotes?: boolean }) {
  const tokens = useMemo(() => translationTokens(text), [text]);
  const notes = useContext(FootnoteContext);
  const render = (items: TranslationToken[], base: string): ReactNode[] => items.map((token, index) => {
    const key = `${base}-${index}`;
    if (token.kind === "text") return <Fragment key={key}>{token.text}</Fragment>;
    if (token.kind === "br") return <br key={key} />;
    if (token.kind === "math") {
      const html = translationMathHtml(token);
      return html ? <span key={key} className={`tr-math${token.display ? " tr-math-display" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <span key={key} className="tr-math-raw" title="수식 문법을 확인해 주세요">{token.raw}</span>;
    }
    const label = footnoteLabel(token);
    const note = label && linkFootnotes ? notes.get(label) : undefined;
    if (note) return <FootnoteRef key={key} note={note} sourceLabel="원문 각주" body={<TrText text={note.html} linkFootnotes={false} />} />;
    const Tag = token.tag;
    return <Tag key={key}>{render(token.children, key)}</Tag>;
  });
  return <>{render(tokens, "tr")}</>;
});
