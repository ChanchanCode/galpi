// 중간 포맷(document.json) 타입 — 명세 §5 계약. 파이프라인과 동시 변경.

export type BlockType =
  | "heading"
  | "paragraph"
  | "formula"
  | "table"
  | "figure"
  | "caption"
  | "list"
  | "footnote"
  | "reference";

export interface PageInfo {
  index: number; // 1-indexed
  image: string; // pages/page-N.png(벡터) 또는 .jpg(스캔) — 확장자를 가정하지 말고 이 값을 그대로 쓸 것
  width_pt: number;
  height_pt: number;
  image_width_px: number;
  image_height_px: number;
  dpi: number;
  // 이 쪽이 진짜 벡터인가(SVG 에 <image> 가 없다). 보기 B 가 SVG/래스터를 가르는 기준.
  is_vector?: boolean;
  svg?: string; // 벡터 쪽만: pages/page-N.svg
  // 텍스트가 있는 쪽만: pages/page-N.text.json — 원본 모드 선택용 줄 좌표(SPEC-CHAT §4.8, textLayer.ts)
  text?: string;
}

export interface Block {
  id: string;
  type: BlockType;
  page: number;
  bbox: [number, number, number, number] | null;
  level?: number; // heading
  text?: string;
  latex?: string; // formula
  display?: boolean; // formula: block/inline
  html?: string; // table
  image?: string; // figure / 폴백 이미지 (assets/ 상대)
  needs_review?: boolean;
}

export interface PaperDocument {
  doc_id: string;
  title: string | null;
  authors?: string | null;
  journal?: string | null;
  source_pdf: string;
  page_count: number;
  pages: PageInfo[];
  blocks: Block[];
}
