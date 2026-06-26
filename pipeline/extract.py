"""추출 파이프라인 CLI 엔트리 (명세 §4.1).

    python extract.py <input.pdf> [output_root] [--dpi 200] [--backend auto]
                      [--inspect]

입력 PDF → 문서별 작업 폴더(§4.1):
    <output_root>/<doc_id>/
      ├─ document.json        중간 포맷 (§5)
      ├─ pages/page-<n>.png   페이지별 고DPI 래스터 (1-indexed)
      ├─ assets/              추출된 그림/표/수식 crop (MinerU images 복사)
      └─ source.pdf           원본 사본 (대조용)

output_root 기본값: ~/Library/Application Support/PaperReader/docs (macOS).
뷰어와 동일 경로 규약 — 뷰어는 Electron app.getPath('userData') 로 같은 곳을 본다.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

import build_document
import mineru_adapter
from rasterize import rasterize_pdf


def default_output_root() -> Path:
    """OS별 앱 데이터 폴더. macOS 우선, 타 OS 대비 분기 (Windows 이식 여지)."""
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/PaperReader/docs"
    if sys.platform == "win32":  # 미검증 — 코드만 열어둠
        import os

        return Path(os.environ.get("APPDATA", Path.home())) / "PaperReader/docs"
    return Path.home() / ".local/share/PaperReader/docs"  # Linux 등


def make_doc_id(pdf_path: Path) -> str:
    """파일명 + 내용 해시 앞 8자리로 안정적 doc_id 생성."""
    h = hashlib.sha1(pdf_path.read_bytes()).hexdigest()[:8]
    stem = "".join(c if c.isalnum() else "-" for c in pdf_path.stem).strip("-").lower()
    return f"{stem[:40]}-{h}"


def collect_assets(mineru_out: Path, workdir: Path) -> None:
    """MinerU 가 만든 images/ (표·그림 crop)를 작업 폴더 assets/ 로 복사.

    document.json 의 image 경로는 'assets/<name>' 상대경로를 가리키게 정규화한다.
    """
    assets_dir = workdir / "assets"
    assets_dir.mkdir(exist_ok=True)
    for img_dir in mineru_out.rglob("images"):
        if img_dir.is_dir():
            for img in img_dir.iterdir():
                if img.is_file():
                    shutil.copy2(img, assets_dir / img.name)


def remap_asset_paths(document: dict) -> None:
    """블록의 image 상대경로를 assets/<basename> 로 정규화."""
    for b in document["blocks"]:
        img = b.get("image")
        if img:
            b["image"] = f"assets/{Path(img).name}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Paper Reflow Reader 추출 파이프라인")
    ap.add_argument("pdf", type=Path, help="입력 PDF 경로")
    ap.add_argument("output_root", type=Path, nargs="?", default=None,
                    help="출력 루트 (기본: 앱 데이터 폴더)")
    ap.add_argument("--dpi", type=int, default=200, help="페이지 래스터 DPI (기본 200)")
    ap.add_argument("--backend", default="auto",
                    help="MinerU 백엔드 (auto|hybrid-engine|vlm-engine|pipeline)")
    ap.add_argument("--effort", default="high", choices=["medium", "high"],
                    help="hybrid 백엔드 정밀도 (기본 high=품질 우선)")
    ap.add_argument("--inspect", action="store_true",
                    help="MinerU 출력 구조만 덤프하고 종료 (§14-2 캘리브레이션)")
    ap.add_argument("--skip-mineru", action="store_true",
                    help="기존 MinerU 출력 재사용(재추출 생략). 파싱·빌드만 재실행.")
    args = ap.parse_args()

    pdf_path: Path = args.pdf.expanduser().resolve()
    if not pdf_path.exists():
        print(f"입력 PDF 없음: {pdf_path}", file=sys.stderr)
        return 1

    output_root = (args.output_root or default_output_root()).expanduser()
    doc_id = make_doc_id(pdf_path)
    workdir = output_root / doc_id
    workdir.mkdir(parents=True, exist_ok=True)
    print(f"[extract] doc_id={doc_id}\n[extract] workdir={workdir}")

    # 1) MinerU 실행 (또는 기존 출력 재사용)
    mineru_out = workdir / "mineru"
    if args.skip_mineru:
        if not mineru_out.exists():
            print(f"기존 MinerU 출력 없음: {mineru_out}", file=sys.stderr)
            return 1
        print(f"[extract] MinerU 재사용: {mineru_out}")
    else:
        mineru_out = mineru_adapter.run_mineru(
            pdf_path, workdir, backend=args.backend, effort=args.effort
        )

    if args.inspect:
        mineru_adapter.inspect_output(mineru_out)
        return 0

    # 2) 페이지 래스터화 + 좌표계 기록 (§9.3)
    pages = rasterize_pdf(pdf_path, workdir, dpi=args.dpi)
    print(f"[extract] rasterized {len(pages)} pages @ {args.dpi}dpi")

    # 3) MinerU 출력 파싱 → 중간 포맷 빌드 (§5)
    raw_blocks = mineru_adapter.parse(mineru_out)
    collect_assets(mineru_out, workdir)
    document = build_document.build_document(doc_id, raw_blocks, pages)
    remap_asset_paths(document)

    # 원본 사본 (대조용, §4.1)
    shutil.copy2(pdf_path, workdir / "source.pdf")

    # 4) 검증 로그 + 저장 (§4.2-4)
    build_document.validate_and_log(document)
    out = build_document.write_document(document, workdir)
    print(f"[extract] wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
