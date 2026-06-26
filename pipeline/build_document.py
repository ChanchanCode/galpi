"""중간 포맷(document.json) 빌드 (명세 §4.2-3, §5).

MinerU RawBlock 목록 + 페이지 래스터 정보를 받아, 뷰어와의 계약인 §5 스키마로
정규화한다. 읽기 순서 보존, 하이픈 줄바꿈 병합, 문단 경계 정규화.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from mineru_adapter import BBOX_NORM, RawBlock
from rasterize import PageRaster

# MinerU 원시 타입 → 중간 포맷 type (§5)
_TYPE_MAP = {
    "title": "heading",
    "text": "paragraph",
    "equation": "formula",
    "table": "table",
    "image": "figure",
    "list": "list",
    "caption": "caption",
    "footnote": "footnote",
    "reference": "reference",
}

# 줄 끝에서 하이픈으로 잘린 단어 병합 (§4.2-3).
# 단어문자 + '-' + 줄바꿈 + 소문자 → 병합. 진짜 하이픈 단어(cost-benefit)는 보존.
_HYPHEN_BREAK = re.compile(r"(\w)-\s*\n\s*([a-z])")
# 그 외 줄바꿈은 공백으로 (문단 내 줄바꿈 정규화)
_SOFT_BREAK = re.compile(r"\s*\n\s*")
_MULTI_WS = re.compile(r"[ \t]{2,}")
# MinerU 가 텍스트에 남기는 마크다운 이스케이프 해제 (\* \& \% 등 → 원문자).
# ⚠️ 인라인 수식 $...$ 안의 LaTeX 백슬래시는 건드리면 안 되므로, $ 구간 밖에서만 적용.
_MD_ESCAPE = re.compile(r"\\([*&%#_~^{}])")
_INLINE_MATH = re.compile(r"(?<!\\)\$(.+?)(?<!\\)\$")


def _unescape_outside_math(text: str) -> str:
    """$...$ 인라인 수식 구간은 보존하고, 그 바깥의 마크다운 이스케이프만 해제."""
    out: list[str] = []
    last = 0
    for m in _INLINE_MATH.finditer(text):
        out.append(_MD_ESCAPE.sub(r"\1", text[last:m.start()]))
        out.append(m.group(0))  # 수식 원본 그대로
        last = m.end()
    out.append(_MD_ESCAPE.sub(r"\1", text[last:]))
    return "".join(out)


def _normalize_text(text: str | None) -> str:
    if not text:
        return ""
    text = _HYPHEN_BREAK.sub(r"\1\2", text)
    text = _SOFT_BREAK.sub(" ", text)
    text = _MULTI_WS.sub(" ", text)
    text = _unescape_outside_math(text)
    return text.strip()


def _norm_to_points(
    bbox: list[float] | None, page: PageRaster | None
) -> list[float] | None:
    """content_list 1000 정규화 bbox → PDF 포인트 (§9.3 캘리브레이션).

    각 축 독립 스케일, 원점 top-left, y 뒤집기 없음.
    뷰어는 이 PDF포인트 bbox 를 image_px/width_pt 로 곱해 픽셀로 변환(§9.3).
    """
    if not bbox or page is None:
        return None
    sx = page.width_pt / BBOX_NORM
    sy = page.height_pt / BBOX_NORM
    return [
        round(bbox[0] * sx, 2),
        round(bbox[1] * sy, 2),
        round(bbox[2] * sx, 2),
        round(bbox[3] * sy, 2),
    ]


def build_document(
    doc_id: str,
    raw_blocks: list[RawBlock],
    pages: list[PageRaster],
    title: str | None = None,
) -> dict:
    """RawBlock + 페이지 정보 → document.json dict (§5)."""
    page_by_idx = {p.index - 1: p for p in pages}  # 0-indexed page_idx → PageRaster
    blocks_out: list[dict] = []
    for i, rb in enumerate(raw_blocks):
        block_type = _TYPE_MAP.get(rb.type, "paragraph")
        block: dict = {
            "id": f"b{i:04d}",  # 문서 내 고유, 읽기 순서대로
            "type": block_type,
            "page": rb.page_idx + 1,  # mineru 0-indexed → 1-indexed (§5)
            "bbox": _norm_to_points(rb.bbox, page_by_idx.get(rb.page_idx)),  # PDF포인트
            "needs_review": False,
        }
        if block_type == "heading":
            block["level"] = rb.level or 2
            block["text"] = _normalize_text(rb.text)
        elif block_type == "formula":
            block["latex"] = rb.latex or ""
            block["display"] = rb.display if rb.display is not None else True
            if not block["latex"].strip():
                block["needs_review"] = True  # 빈 수식은 검토 대상 (§7)
        elif block_type == "table":
            block["html"] = rb.html or ""
            if rb.image_rel:
                block["image"] = rb.image_rel  # 깨졌을 때 폴백 이미지 (§6.1)
            if not block["html"].strip():
                block["needs_review"] = True
        elif block_type == "figure":
            block["image"] = rb.image_rel or ""
            if rb.text:
                block["text"] = _normalize_text(rb.text)  # 캡션
        else:  # paragraph / caption / list / footnote / reference
            block["text"] = _normalize_text(rb.text)

        blocks_out.append(block)

    # 제목 미지정 시 첫 level-1 heading 을 문서 제목으로 (없으면 첫 heading)
    if title is None:
        h1 = next((b for b in blocks_out if b["type"] == "heading" and b.get("level") == 1), None)
        h_any = next((b for b in blocks_out if b["type"] == "heading"), None)
        title = (h1 or h_any or {}).get("text")

    document = {
        "doc_id": doc_id,
        "title": title,
        "source_pdf": "source.pdf",
        "page_count": len(pages),
        "pages": [p.to_page_dict() for p in pages],
        "blocks": blocks_out,
    }
    return document


def validate_and_log(document: dict) -> None:
    """추출 품질 가늠용 검증 로그 (명세 §4.2-4)."""
    blocks = document["blocks"]
    n_formula = sum(1 for b in blocks if b["type"] == "formula")
    n_table = sum(1 for b in blocks if b["type"] == "table")
    n_no_bbox = sum(1 for b in blocks if not b.get("bbox"))
    n_empty_text = sum(
        1
        for b in blocks
        if b["type"] in ("paragraph", "heading") and not b.get("text", "").strip()
    )
    n_review = sum(1 for b in blocks if b.get("needs_review"))

    print("=== 추출 검증 (§4.2-4) ===")
    print(f"  총 블록: {len(blocks)}  /  페이지: {document['page_count']}")
    print(f"  수식(formula): {n_formula}  /  표(table): {n_table}")
    print(f"  bbox 누락: {n_no_bbox}  (원본 대조 폴백=페이지 전체)")
    print(f"  빈 텍스트 블록: {n_empty_text}")
    print(f"  needs_review: {n_review}")


def write_document(document: dict, workdir: Path) -> Path:
    """document.json 원자적 쓰기 (뷰어가 반쯤 쓰인 파일을 읽지 않도록)."""
    import os

    out = workdir / "document.json"
    tmp = workdir / "document.json.tmp"
    tmp.write_text(json.dumps(document, ensure_ascii=False, indent=2))
    os.replace(tmp, out)  # 원자적 교체
    return out
