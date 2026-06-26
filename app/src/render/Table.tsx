// 표 렌더 (명세 §6.1, §14-3). MinerU HTML 을 DOMPurify 로 sanitize 후 삽입.
// 깨진 경우 원본 이미지 폴백 토글.
import { useMemo, useState } from "react";
import DOMPurify from "dompurify";

interface Props {
  html: string;
  imageUrl?: string; // 폴백 이미지 (assets)
}

// 허용 태그 화이트리스트 (§14-3): 표 구조만.
// dompurify v3.2는 자체 타입 동봉 — 명시 타입 없이 객체 리터럴로 전달(추론).
const TABLE_CONFIG = {
  ALLOWED_TAGS: ["table", "thead", "tbody", "tr", "td", "th", "caption", "colgroup", "col", "br"],
  ALLOWED_ATTR: ["colspan", "rowspan"],
};

export function Table({ html, imageUrl }: Props) {
  const [showImage, setShowImage] = useState(false);
  const clean = useMemo(() => DOMPurify.sanitize(html, TABLE_CONFIG), [html]);
  const empty = !clean.trim();

  if ((empty || showImage) && imageUrl) {
    return (
      <figure className="table-figure">
        <img src={imageUrl} alt="원본 표" className="table-image" />
        {!empty && (
          <button className="table-toggle" onClick={() => setShowImage(false)}>
            HTML 표로 보기
          </button>
        )}
      </figure>
    );
  }

  return (
    <div className="table-wrap">
      <div className="table-scroll" dangerouslySetInnerHTML={{ __html: clean }} />
      {imageUrl && (
        <button className="table-toggle" onClick={() => setShowImage(true)}>
          원본 이미지로 보기
        </button>
      )}
    </div>
  );
}
