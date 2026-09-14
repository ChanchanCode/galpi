// 본문 RichText 가 참조 마커를 클릭형으로 바꿀 수 있도록 맵을 컨텍스트로 제공.
// footnotes.ts(순수)와 떼어 둔 이유: main 번들(paperContext·autoPipeline)이 buildFootnotes 를 가져가며 react 까지 끌려갔다.
import { createContext } from "react";
import type { Footnote } from "./footnotes";

export const FootnoteContext = createContext<Map<string, Footnote>>(new Map());
