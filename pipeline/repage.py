"""이미 추출된 문서의 pages[] 만 다시 굽는다 (PLAN-AI D6·D7·H5).

MinerU 를 다시 돌리지 않는다. `source.pdf` 로 rasterize 만 재실행해
`document.json` 의 `pages[]` 를 갈아 끼운다.

왜 따로 있나: 벡터 SVG(`pages[].svg`)와 해상도 상한 해제(H5)는 2026-08-26 에 들어갔는데,
그 전에 추출한 문서는 200dpi PNG 만 갖고 있다. 전체 재추출은 MinerU 를 다시 돌려야 하고
**블록 id 가 밀려 기존 state.json 주석이 깨질 수 있다**(D24). pages[] 는 blocks[] 와 독립이라
여기만 갈아 끼우는 게 안전하다.

    python repage.py --all
    python repage.py <doc_id> [<doc_id> ...]
    python repage.py --all --text-only   # 텍스트층(pages/page-N.text.json)만 — SVG/PNG 는 안 건드린다
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

import fitz  # PyMuPDF

from rasterize import rasterize_pdf, write_page_text


def default_docs_root() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Galpi/docs"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home())) / "Galpi/docs"
    return Path.home() / ".local/share/Galpi/docs"


def atomic_write_json(path: Path, data: dict) -> None:
    """tmp → rename. 쓰는 중 죽어도 document.json 이 반쪽으로 남지 않게."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def repage(workdir: Path, dpi: int = 200) -> str:
    doc_file = workdir / "document.json"
    pdf = workdir / "source.pdf"
    if not doc_file.exists():
        return f"{workdir.name}: document.json 없음 — 건너뜀"
    if not pdf.exists():
        return f"{workdir.name}: source.pdf 없음 — 건너뜀"

    doc = json.loads(doc_file.read_text(encoding="utf-8"))
    old_files = {p.get(k) for p in doc.get("pages", []) for k in ("image", "text")}

    pages = rasterize_pdf(pdf, workdir, dpi=dpi, vector=True)
    doc["pages"] = [p.to_page_dict() for p in pages]
    atomic_write_json(doc_file, doc)

    # 확장자가 바뀐 경우(PNG→JPEG) 옛 파일이 고아로 남는다 — 지금 참조되는 것만 남긴다.
    new_files = {p["image"] for p in doc["pages"]} | {
        p[k] for p in doc["pages"] for k in ("svg", "text") if p.get(k)
    }
    removed = 0
    for rel in old_files - new_files:
        if not rel:
            continue
        f = workdir / rel
        if f.exists():
            f.unlink()
            removed += 1

    n_vec = sum(1 for p in doc["pages"] if p.get("is_vector"))
    dpis = sorted({p["dpi"] for p in doc["pages"]})
    return (
        f"{workdir.name}: {len(pages)}쪽 · 벡터 {n_vec} · dpi {dpis}"
        f" · 고아 {removed}개 정리"
    )


def retext(workdir: Path) -> str:
    """텍스트층만 다시 뽑아 `pages[].text` 만 갱신한다 (SPEC-CHAT §4.8).

    그림(SVG/PNG)은 그대로 둔다 — 쪽 이미지를 다시 구우면 수백 MB 를 새로 쓴다.
    """
    doc_file = workdir / "document.json"
    pdf = workdir / "source.pdf"
    if not doc_file.exists():
        return f"{workdir.name}: document.json 없음 — 건너뜀"
    if not pdf.exists():
        return f"{workdir.name}: source.pdf 없음 — 건너뜀"

    indices = [int(p.get("index", 0)) for p in json.loads(doc_file.read_text(encoding="utf-8")).get("pages", [])]
    texts: dict[int, str | None] = {}
    n_lines = 0
    with fitz.open(pdf) as src:
        for i in indices:
            if 1 <= i <= src.page_count:
                texts[i], n = write_page_text(src[i - 1], workdir, i)
                n_lines += n
            else:
                texts[i] = None

    # 추출(느린 쪽)이 끝난 **뒤에** 다시 읽어 pages[].text 만 고친다 — 그 사이 앱이 document.json 을
    # 고쳤어도(수식 편집 등) 덮어쓰지 않게 읽기-쓰기 간격을 줄인다.
    doc = json.loads(doc_file.read_text(encoding="utf-8"))
    for p in doc.get("pages", []):
        rel = texts.get(int(p.get("index", 0)))
        if rel:
            p["text"] = rel
        else:
            p.pop("text", None)
    atomic_write_json(doc_file, doc)

    n_text = sum(1 for v in texts.values() if v)
    return f"{workdir.name}: {len(indices)}쪽 · 텍스트 {n_text}쪽 · 줄 {n_lines}"


def main() -> None:
    ap = argparse.ArgumentParser(description="추출된 문서의 pages[] 만 재생성")
    ap.add_argument("doc_ids", nargs="*", help="doc_id (생략 시 --all 필요)")
    ap.add_argument("--all", action="store_true", help="docs 폴더의 모든 문서")
    ap.add_argument("--root", type=Path, default=None)
    ap.add_argument("--dpi", type=int, default=200, help="하한 DPI (스캔본은 자동으로 올라간다)")
    ap.add_argument("--text-only", action="store_true", help="텍스트층만 재생성 (SVG/PNG 유지)")
    args = ap.parse_args()

    root = args.root or default_docs_root()
    if args.all:
        targets = sorted(d for d in root.iterdir() if d.is_dir())
    elif args.doc_ids:
        targets = [root / d for d in args.doc_ids]
    else:
        ap.error("doc_id 를 주거나 --all 을 쓰세요")

    for t in targets:
        try:
            print(retext(t) if args.text_only else repage(t, dpi=args.dpi), flush=True)
        except Exception as err:  # 한 문서 실패가 나머지를 막지 않게
            print(f"{t.name}: 실패 — {err}", flush=True)


if __name__ == "__main__":
    main()
