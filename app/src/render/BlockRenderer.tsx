// 블록 렌더러 (명세 §6.1). blocks 를 순서대로 reflow 렌더.
// 모든 요소에 data-block-id / data-page / data-bbox 부착 (원본대조·하이라이트용).
import type { Block } from "../types";
import { Formula } from "./Formula";
import { Table } from "./Table";
import { RichText } from "./RichText";

interface Props {
  block: Block;
  docId: string;
}

function dataAttrs(b: Block) {
  return {
    "data-block-id": b.id,
    "data-page": b.page,
    "data-bbox": b.bbox ? b.bbox.join(",") : undefined,
  };
}

export function BlockRenderer({ block, docId }: Props) {
  const attrs = dataAttrs(block);
  const assetUrl = (rel?: string) => (rel ? window.paperAPI.assetUrl(docId, rel) : undefined);

  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level ?? 2, 1), 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      return <Tag {...attrs} className="blk-heading"><RichText text={block.text ?? ""} /></Tag>;
    }
    case "formula":
      return (
        <div {...attrs} className="blk-formula" data-needs-review={block.needs_review || undefined}>
          <Formula latex={block.latex ?? ""} display={block.display ?? true} />
        </div>
      );
    case "table":
      return (
        <div {...attrs} className="blk-table">
          <Table html={block.html ?? ""} imageUrl={assetUrl(block.image)} />
        </div>
      );
    case "figure":
      return (
        <figure {...attrs} className="blk-figure">
          {block.image && <img src={assetUrl(block.image)} alt={block.text ?? "figure"} />}
          {block.text && <figcaption><RichText text={block.text} /></figcaption>}
        </figure>
      );
    case "caption":
      return <p {...attrs} className="blk-caption"><RichText text={block.text ?? ""} /></p>;
    case "footnote":
      return <p {...attrs} className="blk-footnote"><RichText text={block.text ?? ""} /></p>;
    case "reference":
      return <p {...attrs} className="blk-reference"><RichText text={block.text ?? ""} /></p>;
    case "list":
      return <p {...attrs} className="blk-list"><RichText text={block.text ?? ""} /></p>;
    case "paragraph":
    default:
      return <p {...attrs} className="blk-paragraph"><RichText text={block.text ?? ""} /></p>;
  }
}
