"""페이지 래스터화 (명세 §4.2-2, §9.3).

PyMuPDF(fitz)로 각 페이지를 고DPI PNG로 저장하고, PDF point ↔ image pixel
변환에 필요한 scale 정보를 기록한다. 이 정보는 중간 포맷의 `pages[]`에 들어가
뷰어의 원본 대조(Source Peek) 좌표 변환에 쓰인다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF


@dataclass
class PageRaster:
    """한 페이지의 래스터 결과 + 좌표계 메타데이터."""

    index: int  # 1-indexed
    image_rel: str  # 작업 폴더 기준 상대 경로 (예: "pages/page-1.png")
    width_pt: float  # PDF point 단위 페이지 폭
    height_pt: float
    image_width_px: int
    image_height_px: int
    dpi: int

    def to_page_dict(self) -> dict:
        """document.json 의 pages[] 항목으로 직렬화 (명세 §5)."""
        return {
            "index": self.index,
            "image": self.image_rel,
            "width_pt": round(self.width_pt, 2),
            "height_pt": round(self.height_pt, 2),
            "image_width_px": self.image_width_px,
            "image_height_px": self.image_height_px,
            "dpi": self.dpi,
        }


def rasterize_pdf(pdf_path: Path, workdir: Path, dpi: int = 200) -> list[PageRaster]:
    """각 페이지를 PNG로 저장하고 PageRaster 목록을 반환.

    DPI 기본 200(설정 가능). 품질 우선이므로 필요 시 상향.
    """
    pages_dir = workdir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    # fitz: 72 DPI 가 기본 좌표계(1 point = 1/72 inch). zoom = dpi/72.
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)

    results: list[PageRaster] = []
    with fitz.open(pdf_path) as doc:
        for i, page in enumerate(doc, start=1):
            rect = page.rect  # PDF point 단위 (좌상단 원점, fitz 좌표계)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image_rel = f"pages/page-{i}.png"
            pix.save(str(workdir / image_rel))
            results.append(
                PageRaster(
                    index=i,
                    image_rel=image_rel,
                    width_pt=rect.width,
                    height_pt=rect.height,
                    image_width_px=pix.width,
                    image_height_px=pix.height,
                    dpi=dpi,
                )
            )
    return results
