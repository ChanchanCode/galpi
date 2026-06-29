"""추출 파이프라인 CLI 엔트리 (명세 §4.1).

    python extract.py <input.pdf> [output_root] [--dpi 200] [--backend auto]
                      [--inspect]

입력 PDF → 문서별 작업 폴더(§4.1):
    <output_root>/<doc_id>/
      ├─ document.json        중간 포맷 (§5)
      ├─ pages/page-<n>.png   페이지별 고DPI 래스터 (1-indexed)
      ├─ assets/              추출된 그림/표/수식 crop (MinerU images 복사)
      └─ source.pdf           원본 사본 (대조용)

output_root 기본값: ~/Library/Application Support/Galpi/docs (macOS).
뷰어와 동일 경로 규약 — 뷰어는 Electron app.getPath('userData') 로 같은 곳을 본다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import build_document
import mineru_adapter
import paper_meta
from rasterize import rasterize_pdf


def default_output_root() -> Path:
    """OS별 앱 데이터 폴더. macOS 우선, 타 OS 대비 분기 (Windows 이식 여지)."""
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Galpi/docs"
    if sys.platform == "win32":  # 미검증 — 코드만 열어둠
        import os

        return Path(os.environ.get("APPDATA", Path.home())) / "Galpi/docs"
    return Path.home() / ".local/share/Galpi/docs"  # Linux 등


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


def write_status(workdir: Path, state: str, pages_done: int, page_count: int) -> None:
    """추출 진행 상태를 status.json 으로 (뷰어가 '추출 중 n/N' 표시·라이브 갱신).

    state: "extracting" | "done" | "error"
    """
    import os

    payload = {"state": state, "pages_done": pages_done, "page_count": page_count}
    tmp = workdir / "status.json.tmp"
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    os.replace(tmp, workdir / "status.json")


def run_streaming(args, pdf_path: Path, doc_id: str, workdir: Path) -> int:
    """페이지 단위 스트리밍 추출 (명세 사용자 요구).

    1) 전체 페이지를 먼저 래스터화(빠름) → 페이지 이미지·좌표계 즉시 확보.
    2) document.json 을 pages 만 채워 먼저 쓰고 status=extracting.
    3) chunk 페이지씩 MinerU 추출 → page_idx 오프셋 보정 → blocks 누적 →
       매 청크마다 document.json·status 원자적 갱신(뷰어가 라이브로 읽어 이어붙임).
    """
    # 원본 사본 (대조용, §4.1) — 먼저 복사해 Source Peek 도 바로 가능
    shutil.copy2(pdf_path, workdir / "source.pdf")

    # 0) 서지정보(제목/저자/저널) — PDF 메타데이터 + 1페이지 파싱
    meta = paper_meta.extract_paper_meta(pdf_path)
    print(f"[extract] meta: {meta}")

    # 1) 전체 래스터화
    pages = rasterize_pdf(pdf_path, workdir, dpi=args.dpi)
    n = len(pages)
    print(f"[extract] rasterized {n} pages @ {args.dpi}dpi")

    # 2) pages 만 채운 document.json 초기 기록
    document = build_document.build_document(doc_id, [], pages, **meta)
    build_document.write_document(document, workdir)
    write_status(workdir, "extracting", 0, n)

    # 3) 청크 추출 (chunk<=0 이면 단일 청크=전체)
    chunk = args.chunk if args.chunk and args.chunk > 0 else n
    all_raw = []
    try:
        for ci, s in enumerate(range(0, n, chunk)):
            e = min(s + chunk, n) - 1  # -e inclusive, 0-indexed
            sub = f"mineru/chunk-{s:03d}-{e:03d}"
            mineru_out = mineru_adapter.run_mineru(
                pdf_path, workdir, backend=args.backend, effort=args.effort,
                start=s, end=e, out_subdir=sub,
            )
            all_raw.extend(mineru_adapter.parse(mineru_out, page_offset=s))
            collect_assets(mineru_out, workdir)
            document = build_document.build_document(doc_id, all_raw, pages, **meta)
            remap_asset_paths(document)
            build_document.write_document(document, workdir)
            write_status(workdir, "extracting", e + 1, n)
            print(f"[extract] chunk {ci+1}: pages {s+1}-{e+1}/{n}, blocks={len(all_raw)}")
    except Exception:
        write_status(workdir, "error", 0, n)
        raise

    build_document.validate_and_log(document)
    write_status(workdir, "done", n, n)
    print(f"[extract] done → {workdir / 'document.json'}")
    return 0


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
    ap.add_argument("--chunk", type=int, default=6,
                    help="페이지 스트리밍 청크 크기(기본 6). 0이면 전체를 한 번에.")
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

    # --inspect / --skip-mineru: 단일 출력(레거시·디버그 경로) 사용
    if args.inspect:
        mineru_out = mineru_adapter.run_mineru(
            pdf_path, workdir, backend=args.backend, effort=args.effort
        )
        mineru_adapter.inspect_output(mineru_out)
        return 0

    if args.skip_mineru:
        # 기존 mineru 출력(단일 또는 청크들) 재사용해 파싱·빌드만 재실행
        pages = rasterize_pdf(pdf_path, workdir, dpi=args.dpi)
        all_raw = []
        single = workdir / "mineru"
        chunk_dirs = sorted((workdir / "mineru").glob("chunk-*")) if single.exists() else []
        if chunk_dirs:
            for cd in chunk_dirs:
                s = int(cd.name.split("-")[1])  # chunk-<s>-<e>
                all_raw.extend(mineru_adapter.parse(cd, page_offset=s))
                collect_assets(cd, workdir)
        elif single.exists():
            all_raw = mineru_adapter.parse(single)
            collect_assets(single, workdir)
        else:
            print(f"기존 MinerU 출력 없음: {single}", file=sys.stderr)
            return 1
        meta = paper_meta.extract_paper_meta(pdf_path)
        document = build_document.build_document(doc_id, all_raw, pages, **meta)
        remap_asset_paths(document)
        build_document.validate_and_log(document)
        build_document.write_document(document, workdir)
        write_status(workdir, "done", len(pages), len(pages))
        print(f"[extract] (skip-mineru) wrote {workdir / 'document.json'}")
        return 0

    # 기본: 페이지 스트리밍 추출
    return run_streaming(args, pdf_path, doc_id, workdir)


if __name__ == "__main__":
    raise SystemExit(main())
