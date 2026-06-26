"""MinerU 실행 & 출력 파싱 (명세 §4.2, §14-2).

⚠️ 중요(§14-2): MinerU 출력의 정확한 필드명·좌표 기준(bbox가 PDF point인지
이미지 픽셀인지, 원점이 좌상단인지 좌하단인지)은 **설치된 버전의 실제 출력을
열어 확인**해야 한다. 가정 금지. 아래 매핑은 일반적인 MinerU 스키마 기준의
초안이며, `inspect_output()` 으로 실제 구조를 덤프해 검증·보정한다.

MinerU 출력물(작업 폴더 내):
  - <name>_content_list.json : 읽기 순서대로의 블록 목록 (text/equation/table/image)
                               단, bbox 가 없을 수 있음.
  - <name>_middle.json       : 페이지별 para_blocks (bbox 포함). Source Peek 에 필수.
  - images/                  : 표/그림 crop 이미지
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _mineru_bin() -> str:
    """현재 venv 의 mineru 실행 파일 경로를 우선 사용 (PATH 미설정 대비)."""
    candidate = Path(sys.executable).parent / "mineru"
    if candidate.exists():
        return str(candidate)
    found = shutil.which("mineru")
    if found:
        return found
    raise FileNotFoundError("mineru 실행 파일을 찾을 수 없음. venv 활성화 또는 설치 확인.")


@dataclass
class RawBlock:
    """MinerU 출력에서 추출한 정규화 이전 블록.

    build_document.py 가 이를 받아 중간 포맷(§5) blocks[] 로 변환한다.
    """

    type: str  # mineru 원시 타입 (text/title/equation/table/image/...)
    page_idx: int  # 0-indexed (mineru 기준). build 단계에서 +1.
    bbox: list[float] | None = None  # [x0,y0,x1,y1] — 좌표계는 calibrate 로 확정
    text: str | None = None
    latex: str | None = None
    display: bool | None = None  # equation: block(True) / inline(False)
    html: str | None = None  # table HTML
    image_rel: str | None = None  # 작업 폴더 기준 상대 경로
    level: int | None = None  # heading level
    extra: dict = field(default_factory=dict)


# ── MinerU 실행 ────────────────────────────────────────────────────────────


def run_mineru(
    pdf_path: Path,
    workdir: Path,
    backend: str = "auto",
    effort: str = "high",
    start: int | None = None,
    end: int | None = None,
    out_subdir: str = "mineru",
) -> Path:
    """MinerU CLI 실행. 출력 폴더(작업 폴더 내 mineru 산출물 루트)를 반환.

    검증된 환경: MinerU 3.4.0 (설치 시점 최신). 명세 §3 메모대로 버전은
    하드코딩하지 않고 설치본에 맞춤. 3.4.0 백엔드:
      pipeline | vlm-engine | hybrid-engine | vlm-http-client | hybrid-http-client
    (명세의 `vlm-mlx-engine` 은 구버전 명칭 — 3.4.0엔 없음.)

    backend:
      - "auto": Apple Silicon → hybrid-engine (기본·최고정확도, MLX 자동가속),
                그 외 → pipeline (CPU/CUDA 범용)
      - 명시 지정 가능.
    effort: hybrid-* 백엔드에서만 유효. 품질 최우선이므로 기본 "high"
            (이미지/차트 분석 포함, 느리지만 정확).

    MLX 가속: Apple Silicon에서 mlx/mlx_vlm 설치 시 vlm/hybrid 엔진이 자동 사용.
    플랫폼 분기는 여기 한 곳에만 둔다 → Windows 이식 시 이 함수만 손보면 됨.
    """
    if backend == "auto":
        import platform

        is_apple_silicon = platform.system() == "Darwin" and platform.machine() == "arm64"
        backend = "hybrid-engine" if is_apple_silicon else "pipeline"

    out_dir = workdir / out_subdir
    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [_mineru_bin(), "-p", str(pdf_path), "-o", str(out_dir), "-b", backend]
    if backend.startswith("hybrid"):
        cmd += ["--effort", effort]  # pipeline 백엔드엔 --effort 없음
    # 페이지 범위(0-indexed, -e inclusive). 청크 추출에 사용.
    # ⚠️(§14-2 검증) 범위 추출 시 출력 page_idx 는 0부터 리셋됨 → 호출측에서 start 오프셋 보정.
    if start is not None:
        cmd += ["-s", str(start)]
    if end is not None:
        cmd += ["-e", str(end)]
    print(f"[mineru] running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    return out_dir


# ── 출력 검사(캘리브레이션용) ─────────────────────────────────────────────


def find_output_files(mineru_out: Path) -> dict[str, Path]:
    """mineru 출력 폴더에서 핵심 산출물 경로를 찾아 반환."""
    found: dict[str, Path] = {}
    for p in mineru_out.rglob("*.json"):
        name = p.name
        if name.endswith("_content_list.json"):
            found["content_list"] = p
        elif name.endswith("_middle.json"):
            found["middle"] = p
        elif name.endswith("_model.json"):
            found["model"] = p
    return found


def inspect_output(mineru_out: Path) -> None:
    """실제 출력 구조를 사람이 읽기 쉽게 덤프 (§14-2 캘리브레이션).

    실행 후 이 출력을 보고 아래 parse_* 함수의 필드 매핑·좌표계를 확정한다.
    """
    files = find_output_files(mineru_out)
    print("=== MinerU output files ===")
    for k, v in files.items():
        print(f"  {k}: {v}")

    if "content_list" in files:
        data = json.loads(files["content_list"].read_text())
        print(f"\n=== content_list.json: {len(data)} blocks ===")
        seen_types: dict[str, dict] = {}
        for blk in data:
            t = blk.get("type", "?")
            if t not in seen_types:
                seen_types[t] = blk
        for t, sample in seen_types.items():
            print(f"\n  [type={t}] keys={list(sample.keys())}")
            print(f"    sample: {json.dumps(sample, ensure_ascii=False)[:300]}")

    if "middle" in files:
        data = json.loads(files["middle"].read_text())
        pdf_info = data.get("pdf_info", data if isinstance(data, list) else [])
        print(f"\n=== middle.json: {len(pdf_info)} pages ===")
        if pdf_info:
            p0 = pdf_info[0]
            print(f"  page0 keys={list(p0.keys())}")
            blocks = p0.get("para_blocks") or p0.get("preproc_blocks") or []
            print(f"  page0 block count={len(blocks)}")
            if blocks:
                print(f"  block0 keys={list(blocks[0].keys())}")
                print(f"  block0 sample: {json.dumps(blocks[0], ensure_ascii=False)[:400]}")


# ── 파싱 (MinerU 3.4.0 hybrid-engine content_list.json 기준, 캘리브레이션 완료) ──
#
# §14-2 캘리브레이션 결과 (Carhart 2012, Journal of Finance 로 검증):
#   • content_list.json 이 읽기 순서·내용·LaTeX·HTML 을 깔끔히 담은 단일 소스.
#   • content_list 의 type: text / equation / table / chart / list / page_footnote
#     + 버릴 잡음: header / page_number / aside_text(Wiley 워터마크).
#   • text 에 text_level 이 있으면 heading, 없으면 paragraph.
#   • equation.text = LaTeX (앞뒤 $$ 와 \tag{n} 포함) — $$ 만 벗긴다.
#   • table.table_body = HTML, table.img_path = 폴백 이미지, table_caption[] = 캡션.
#   • chart.img_path = 차트 이미지(figure 로 취급).
#   • bbox 좌표계: content_list 는 1000×1000 정규화 (각 축 독립).
#       검증: 타이틀 bbox [123,116,885,142] / 1000 * page_size(438,654)
#             = [53.9,75.9,387.6,92.8] ≈ middle.json PDF포인트 bbox [54,76,388,93]. ✓
#       원점은 top-left (y 아래로 증가) → §9.3 의 y 뒤집기 불필요.
#   • 정규화 bbox 는 RawBlock.bbox 에 그대로 담고, PDF포인트 변환은
#     build_document 에서 페이지 크기를 알 때 수행 (BBOX_NORM 참조).

BBOX_NORM = 1000.0  # content_list bbox 정규화 척도 (캘리브레이션으로 확정)

_DISCARD_TYPES = {"header", "page_number", "aside_text"}


def parse(mineru_out: Path, page_offset: int = 0) -> list[RawBlock]:
    """MinerU content_list.json → RawBlock 목록 (읽기 순서 보존).

    bbox 는 1000 정규화 좌표 그대로 둔다(build_document 가 PDF포인트로 변환).
    page_offset: 청크 추출 시 chunk 시작 페이지(0-indexed). 출력 page_idx 가
    0부터 리셋되므로 여기에 더해 원본 페이지로 복원한다(§14-2 검증).
    """
    files = find_output_files(mineru_out)
    if "content_list" not in files:
        raise FileNotFoundError(f"content_list.json not found under {mineru_out}")

    content = json.loads(files["content_list"].read_text())
    blocks: list[RawBlock] = []
    for item in content:
        rb = _content_item_to_raw(item)
        if rb is not None:
            rb.page_idx += page_offset
            blocks.append(rb)
    return blocks


def _norm_bbox(item: dict) -> list[float] | None:
    bb = item.get("bbox")
    return [float(x) for x in bb] if bb else None


def _clean_latex(raw: str) -> str:
    """equation.text 에서 KaTeX 입력용 LaTeX 추출 (앞뒤 $$ / 공백 제거)."""
    s = (raw or "").strip()
    if s.startswith("$$"):
        s = s[2:]
    if s.endswith("$$"):
        s = s[:-2]
    return s.strip()


def _content_item_to_raw(item: dict) -> RawBlock | None:
    """content_list.json 한 항목 → RawBlock (MinerU 3.4.0 실제 스키마)."""
    t = item.get("type")
    if t in _DISCARD_TYPES:
        return None  # 페이지 헤더/번호/워터마크 잡음 제거
    page = int(item.get("page_idx", 0))
    bbox = _norm_bbox(item)

    if t == "text":
        text = item.get("text", "")
        if not text.strip():
            return None  # 빈 텍스트 블록(VLM 잡음) 제거
        level = item.get("text_level")
        return RawBlock(
            type="title" if level else "text",
            page_idx=page,
            bbox=bbox,
            text=text,
            level=int(level) if level else None,
        )
    if t == "page_footnote":
        return RawBlock(type="footnote", page_idx=page, bbox=bbox, text=item.get("text", ""))
    if t == "equation":
        return RawBlock(
            type="equation",
            page_idx=page,
            bbox=bbox,
            latex=_clean_latex(item.get("text", "")),
            display=True,  # content_list 의 equation 은 interline(block)
        )
    if t == "table":
        caption = " ".join(item.get("table_caption") or [])
        return RawBlock(
            type="table",
            page_idx=page,
            bbox=bbox,
            html=item.get("table_body", ""),
            image_rel=item.get("img_path"),
            text=caption or None,
        )
    if t == "chart":
        caption = " ".join(item.get("chart_caption") or [])
        return RawBlock(
            type="image",
            page_idx=page,
            bbox=bbox,
            image_rel=item.get("img_path"),
            text=caption or None,
        )
    if t == "image":
        caption = " ".join(item.get("img_caption") or [])
        return RawBlock(
            type="image",
            page_idx=page,
            bbox=bbox,
            image_rel=item.get("img_path"),
            text=caption or None,
        )
    if t == "list":
        items = item.get("list_items") or []
        return RawBlock(type="list", page_idx=page, bbox=bbox, text="\n".join(items))
    # 미지 타입: 텍스트로라도 보존 (로그로 잡고 차후 보정)
    return RawBlock(type="text", page_idx=page, bbox=bbox, text=item.get("text", ""))
