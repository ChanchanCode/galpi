"""페이지 래스터화 + 벡터(SVG) 추출 (명세 §4.2-2, §9.3 / PLAN-AI D6·D7·H5).

PyMuPDF(fitz)로 각 페이지를 PNG로 저장하고, PDF point ↔ image pixel 변환에
필요한 scale 정보를 기록한다. 이 정보는 중간 포맷의 `pages[]`에 들어가
뷰어의 원본 대조(Source Peek)·보기 B 좌표 변환에 쓰인다.

두 갈래로 나뉜다 (실측 근거는 PLAN-AI §2.10):
  · **진짜 벡터 페이지** — SVG 로도 뽑는다. 글리프가 <use>/<path> 라 무한 확대가 되고
    fill 속성이 하나도 없어 CSS 한 줄로 테마가 먹는다. gzip 22~39KB/쪽.
  · **래스터가 섞인 페이지** — SVG 를 뽑아 봐야 <image> 한 장이라 확대 이득이 없고
    오히려 무겁다(376~420KB). PNG 를 쓰되 **원본 해상도에 맞춰 DPI 를 올린다**(H5).

`is_vector` 를 PLAN 초안의 `get_fonts()>0 or get_text()>0` 로 판정하면 안 된다.
그 식은 라이브러리 5편 중 3편을 벡터로 오분류한다(OCR 텍스트 레이어가 얹힌 스캔본).
실제로 SVG 를 뽑아 <image> 유무로 판정한다.

쪽마다 **텍스트층**(`pages/page-N.text.json`)도 뽑는다(SPEC-CHAT §4.8). SVG 는 글리프가
path(text_as_path)라 원본 모드에서 글자를 드래그로 고를 수 없다 — 뷰어가 이 줄 좌표에
투명 글자를 겹쳐 선택을 받는다.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import fitz  # PyMuPDF

# 래스터 상한 (H5) — 스캔본 원본이 4300×6000 인데 200dpi 로 1434×2000 으로 굽던 것을 고친다.
#
# 상한을 원본 해상도(460~480dpi)까지 열지 않는 이유는 실측 때문이다:
#   mackinlay 30쪽 · 200dpi 14MB / 300dpi 25MB / 460dpi 45MB (JPEG 환산)
# 보기 B 는 패널 폭 700px 안팎에서 최대 400% 확대를 상정하므로 긴 변 ~2800px 이면 충분하고,
# 3400px 은 거기에 여유를 둔 값이다. 460dpi 는 화면에서 확인할 수 없는 화질에 디스크를 3배 쓴다.
MAX_LONG_EDGE_PX = 3400
MAX_DPI = 400
JPEG_QUALITY = 85

# 텍스트층 추출 플래그 — 이미지 블록은 빼고(스캔본에서 dict 추출이 쪽당 0.1초 넘게 걸리는 원인), 합자는 풀어 둔다
# (복사·인용에 'ﬁ' 한 글자가 아니라 'fi' 가 가야 한다).
_TEXT_FLAGS = fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES & ~fitz.TEXT_PRESERVE_LIGATURES
# 쪽 회전 뒤 좌표계에서 줄 방향 → 단위 벡터 (y 아래로 증가, 각도는 시계 방향 = CSS rotate)
_DIRS = {0: (1.0, 0.0), 90: (0.0, 1.0), 180: (-1.0, 0.0), 270: (0.0, -1.0)}


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
    is_vector: bool = False
    svg_rel: str | None = None  # 벡터 페이지만. 예: "pages/page-1.svg"
    text_rel: str | None = None  # 텍스트가 있는 쪽만. 예: "pages/page-1.text.json"

    def to_page_dict(self) -> dict:
        """document.json 의 pages[] 항목으로 직렬화 (명세 §5)."""
        d = {
            "index": self.index,
            "image": self.image_rel,
            "width_pt": round(self.width_pt, 2),
            "height_pt": round(self.height_pt, 2),
            "image_width_px": self.image_width_px,
            "image_height_px": self.image_height_px,
            "dpi": self.dpi,
            "is_vector": self.is_vector,
        }
        if self.svg_rel:
            d["svg"] = self.svg_rel
        if self.text_rel:
            d["text"] = self.text_rel
        return d


def _native_dpi(page: fitz.Page, floor_dpi: int) -> int:
    """이 페이지에 박힌 이미지의 원본 해상도에 맞는 DPI (H5).

    스캔본은 페이지 전체가 이미지 한 장이다. 그 이미지의 픽셀 폭을 페이지 폭(pt)으로
    나누면 원본이 실제로 갖고 있는 해상도가 나온다. 그보다 낮게 구우면 그냥 화질을 버리는 것.
    벡터 페이지는 박힌 이미지가 없거나 작으므로 floor 가 그대로 쓰인다.
    """
    try:
        images = page.get_images(full=True)
    except Exception:
        return floor_dpi
    if not images:
        return floor_dpi
    w_pt = max(page.rect.width, 1.0)
    h_pt = max(page.rect.height, 1.0)
    best = floor_dpi
    for info in images:
        px_w, px_h = info[2], info[3]
        if not px_w or not px_h:
            continue
        # 이미지가 페이지 전체를 덮는다고 보고 환산 — 부분 삽화면 과대평가되지만
        # 아래 상한이 막아 준다.
        best = max(best, int(72.0 * px_w / w_pt), int(72.0 * px_h / h_pt))
    long_pt = max(w_pt, h_pt)
    cap_by_px = int(72.0 * MAX_LONG_EDGE_PX / long_pt)
    return max(floor_dpi, min(best, MAX_DPI, cap_by_px))


def _svg_is_vector(svg: str) -> bool:
    """SVG 가 진짜 벡터인가 — <image> 가 하나도 없고 글리프가 있어야 한다."""
    return "<image" not in svg and ("<use" in svg or "<path" in svg)


def _prefix_svg_ids(svg: str, prefix: str) -> str:
    """여러 페이지 SVG 를 한 문서에 인라인하므로 <defs> id 가 충돌한다.

    id="font_1_21" 과 xlink:href="#font_1_21", url(#...) 세 곳을 모두 접두한다.
    """
    return (
        svg.replace('id="', f'id="{prefix}')
        .replace('xlink:href="#', f'xlink:href="#{prefix}')
        .replace("url(#", f"url(#{prefix}")
    )


def _quarter_turn(dx: float, dy: float) -> int | None:
    """줄 방향 벡터 → 0/90/180/270. 비스듬한 줄(3° 넘게 틀어짐)은 None — 투명 글자를 못 맞춘다."""
    ang = math.degrees(math.atan2(dy, dx)) % 360.0
    k = int(round(ang / 90.0)) % 4
    off = abs((ang - k * 90.0 + 180.0) % 360.0 - 180.0)
    return k * 90 if off <= 3.0 else None


def _local(rect: fitz.Rect, r: int) -> tuple[float, float, float, float]:
    """쪽 좌표 사각형 → 줄 방향 좌표 (u: 글 방향, v: 글 아래 방향) 의 (u0, u1, v0, v1)."""
    dx, dy = _DIRS[r]
    us = []
    vs = []
    for x, y in ((rect.x0, rect.y0), (rect.x1, rect.y0), (rect.x0, rect.y1), (rect.x1, rect.y1)):
        us.append(x * dx + y * dy)
        vs.append(-x * dy + y * dx)
    return min(us), max(us), min(vs), max(vs)


def page_text_lines(page: fitz.Page) -> list[dict]:
    """쪽의 줄 좌표 목록 — `{x, y, w, h, t}` (+ 회전된 줄만 `r`), PDF pt · 좌상단 원점.

    **좌표는 회전 뒤(화면에 보이는) 쪽 기준이다.** PyMuPDF 의 get_text 는 /Rotate 를 적용하기 전
    좌표를 주고 get_svg_image·get_pixmap 은 회전된 그림을 준다(실측: rotate=90 에서 bbox 는 그대로,
    잉크는 옮겨감). 그래서 `page.rotation_matrix` 로 옮긴다. CropBox 오프셋은 둘 다 이미 뺀다.

    회전된 줄(r≠0)은 x,y 가 **글 방향 기준 좌상단 모서리**, w 는 글 방향 길이, h 는 수직 두께다 —
    뷰어가 `rotate(r) scaleX()` 를 그 점에 걸면 그대로 겹친다. r=0 이면 평범한 bbox 다.
    """
    rm = page.rotation_matrix
    prot = page.rotation % 360
    out: list[dict] = []

    raw = page.get_text("rawdict", flags=_TEXT_FLAGS)
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for ln in block.get("lines", []):
            r0 = _quarter_turn(*ln["dir"])
            if r0 is None:
                continue
            r = (r0 + prot) % 360
            _, _, v0, v1 = _local(fitz.Rect(ln["bbox"]) * rm, r)
            # 글자 단위로 폭을 다시 잡는다 — 줄 bbox 는 줄 끝 공백까지 품어서 그대로 쓰면
            # scaleX 가 공백 폭만큼 글자를 늘린다. 표 칸처럼 크게 벌어진 글자는 MuPDF 가 이미
            # 다른 줄로 나눠 준다(실측: 라이브러리 12.7k 줄 중 한 줄 안 1.5em 넘는 틈 0개).
            u0 = u1 = None
            chars: list[str] = []
            for span in ln.get("spans", []):
                for ch in span.get("chars", []):
                    c = ch.get("c", "")
                    if not c:
                        continue
                    chars.append(c)
                    if c.isspace():
                        continue
                    cu0, cu1, _, _ = _local(fitz.Rect(ch["bbox"]) * rm, r)
                    u0 = cu0 if u0 is None else min(u0, cu0)
                    u1 = cu1 if u1 is None else max(u1, cu1)
            t = "".join(chars).strip()
            if not t or u0 is None or u1 - u0 <= 0.5 or v1 - v0 <= 0.5:
                continue
            dx, dy = _DIRS[r]
            line = {
                "x": round(u0 * dx - v0 * dy, 2),
                "y": round(u0 * dy + v0 * dx, 2),
                "w": round(u1 - u0, 2),
                "h": round(v1 - v0, 2),
                "t": t,
            }
            if r:
                line["r"] = r
            out.append(line)
    return out


def write_page_text(page: fitz.Page, workdir: Path, index: int) -> tuple[str | None, int]:
    """`pages/page-N.text.json` 을 쓰고 (상대경로, 줄 수) 를 돌려준다. 텍스트 0 인 쪽(스캔)은 파일을 지운다."""
    rel = f"pages/page-{index}.text.json"
    path = workdir / rel
    lines = page_text_lines(page)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not lines:
        path.unlink(missing_ok=True)
        return None, 0
    data = {"w": round(page.rect.width, 2), "h": round(page.rect.height, 2), "lines": lines}
    # 뷰어가 열려 있으면 반쪽 파일을 읽을 수 있다 — tmp → rename.
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)
    return rel, len(lines)


def rasterize_pdf(
    pdf_path: Path,
    workdir: Path,
    dpi: int = 200,
    vector: bool = True,
) -> list[PageRaster]:
    """각 페이지를 PNG(+가능하면 SVG)로 저장하고 PageRaster 목록을 반환.

    dpi 는 **하한**이다. 스캔본처럼 원본이 더 높은 해상도를 갖고 있으면 그만큼 올린다.
    """
    pages_dir = workdir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    results: list[PageRaster] = []
    with fitz.open(pdf_path) as doc:
        for i, page in enumerate(doc, start=1):
            rect = page.rect  # PDF point 단위 (좌상단 원점, fitz 좌표계)

            svg_rel: str | None = None
            is_vector = False
            if vector:
                try:
                    svg = page.get_svg_image(text_as_path=True)
                    if _svg_is_vector(svg):
                        is_vector = True
                        svg_rel = f"pages/page-{i}.svg"
                        (workdir / svg_rel).write_text(
                            _prefix_svg_ids(svg, f"p{i}_"), encoding="utf-8"
                        )
                except Exception as err:  # 한 페이지 실패가 추출 전체를 막지 않게
                    print(f"[rasterize] page {i} SVG 실패(무시): {err}")

            # 벡터 페이지는 하한 DPI 로 충분하다(PNG 는 SourcePeek·폴백용).
            page_dpi = dpi if is_vector else _native_dpi(page, dpi)
            zoom = page_dpi / 72.0
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            # 포맷을 나눈다: 벡터 페이지는 글자뿐이라 PNG 가 작고 선명하지만,
            # 스캔본은 사진이라 PNG 가 최악이다(실측 340dpi 1.28MB → JPEG 0.6MB대).
            # 소비처는 전부 pages[].image 문자열을 따라가므로 확장자를 바꿔도 안전하다(전수 확인).
            if is_vector:
                image_rel = f"pages/page-{i}.png"
                pix.save(str(workdir / image_rel))
            else:
                image_rel = f"pages/page-{i}.jpg"
                (workdir / image_rel).write_bytes(pix.tobytes("jpg", jpg_quality=JPEG_QUALITY))

            text_rel: str | None = None
            try:
                text_rel, _ = write_page_text(page, workdir, i)
            except Exception as err:  # 텍스트층은 부가 기능 — 추출 전체를 막지 않게
                print(f"[rasterize] page {i} 텍스트층 실패(무시): {err}")

            results.append(
                PageRaster(
                    index=i,
                    image_rel=image_rel,
                    width_pt=rect.width,
                    height_pt=rect.height,
                    image_width_px=pix.width,
                    image_height_px=pix.height,
                    dpi=page_dpi,
                    is_vector=is_vector,
                    svg_rel=svg_rel,
                    text_rel=text_rel,
                )
            )
    return results
