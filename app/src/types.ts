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
  image: string; // pages/page-N.png (작업 폴더 상대)
  width_pt: number;
  height_pt: number;
  image_width_px: number;
  image_height_px: number;
  dpi: number;
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
