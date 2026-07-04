"""논문 서지정보 추출 (제목/저자/저널) — PDF 메타데이터 + 1페이지 파싱.

Elsevier/ScienceDirect 등은 PDF 메타데이터(title/author/subject)가 잘 채워져 있어
1차 소스로 쓴다. 저자는 메타데이터가 1저자만 담는 경우가 많아 1페이지 본문에서 보강.
어느 것도 못 찾으면 None → 뷰어가 doc_id/heading 으로 폴백.
"""

from __future__ import annotations

import html
import re
from pathlib import Path

import fitz


# 메타데이터 title 이 실제 제목이 아닌 흔한 쓰레기 값 — 워드프로세서 이름, 파일명(.doc 등),
# 문서번호(PII/DOI), URL. 옛 논문·SSRN·Elsevier 스캔본에서 빈번.
_JUNK_TITLE = re.compile(
    r"^(microsoft (word|powerpoint)|powerpoint presentation|corel|wordperfect|acrobat|"
    r"untitled|제목 없음|slide \d)|"
    r"\.(docx?|dvi|tex|qxd|indd|wpd|rtf|pptx?|pdf)\s*$|"
    r"^(pii|doi)\s*:|^https?://",
    re.I,
)


def _usable_title(title: str | None) -> str | None:
    """메타데이터 제목이 진짜 제목으로 쓸 만한지 — 아니면 None(폴백 유도)."""
    if not title or len(title) < 6:
        return None
    if _JUNK_TITLE.search(title):
        return None
    if not re.search(r"[A-Za-zÀ-ÿ가-힣]{3}", title):  # 글자 없는 번호/기호뿐
        return None
    return title


def _plausible_authors(s: str | None) -> bool:
    """사람 이름다운가 — 대문자 시작 토큰 2개 이상('ack', 'petersen' 류 계정명 거부)."""
    return bool(s) and len(re.findall(r"\b[A-ZÀ-Þ][A-Za-zÀ-ÿ’'.-]+", s)) >= 2


def _title_from_page1(doc: fitz.Document) -> str | None:
    """1페이지에서 가장 큰 글꼴 줄(들)을 제목으로 — 메타데이터가 없거나 쓰레기일 때 폴백.

    저널 배너/로고 오탐 방지: 후보는 단어 2개 이상 + 12자 이상 + 페이지 상단 60%.
    본문과 크기 차이가 없으면(스캔 페이지·플랫 조판) 포기하고 None.
    """
    if not doc.page_count:
        return None
    page = doc[0]
    page_h = page.rect.height or 1
    lines: list[tuple[float, float, str]] = []  # (y, size, text)
    for blk in page.get_text("dict")["blocks"]:
        if blk.get("type") != 0:
            continue
        for ln in blk["lines"]:
            text = re.sub(r"\s+", " ", "".join(s["text"] for s in ln["spans"])).strip()
            if not text:
                continue
            size = max(s["size"] for s in ln["spans"])
            lines.append((ln["bbox"][1], size, text))
    if not lines:
        return None
    lines.sort(key=lambda t: t[0])

    cand = [
        (y, size, t)
        for y, size, t in lines
        if len(t) >= 12 and len(t.split()) >= 2 and y < page_h * 0.6
        and re.search(r"[A-Za-zÀ-ÿ가-힣]", t)
    ]
    if not cand:
        return None
    max_size = max(size for _, size, _ in cand)
    sizes = sorted(size for _, size, _ in lines)
    median = sizes[len(sizes) // 2]
    if max_size < median * 1.15:  # 본문과 구분 안 됨 → 오탐 위험, 포기
        return None

    # 첫 최대 크기 후보를 시드로, 바로 이어지는 비슷한 크기 줄을 제목 연속으로 합침
    cand_set = {(y, size, t) for y, size, t in cand}
    seed_idx = next(
        i for i, line in enumerate(lines)
        if line in cand_set and line[1] >= max_size - 0.3
    )
    seed_y, seed_size, _ = lines[seed_idx]
    parts: list[str] = []
    prev_y = seed_y
    for y, size, t in lines[seed_idx:]:
        if size < seed_size - 0.7 or y - prev_y > seed_size * 3 or len(parts) >= 4:
            break
        parts.append(t)
        prev_y = y
    title = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return title if len(title) >= 12 and len(title) <= 300 else None


def _clean_authors(line: str) -> str:
    """저자 줄에서 소속 마커(위첨자 a,b, ∗ 등) 제거 → 'A, B' 형태."""
    s = html.unescape(line)
    s = re.sub(r"[∗*†‡§¶]", "", s)        # 각주/교신 마커
    s = re.sub(r"\b[a-z]\b", "", s)        # 소속 표시용 단일 소문자
    s = re.sub(r"\d", "", s)               # 위첨자 숫자
    s = re.sub(r"\s*,\s*(,\s*)+", ", ", s)  # ", , ," → ", "
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip(" ,;·")


# 저자 줄 다음에 나오면 소속/본문 시작으로 간주하는 신호(여기서 수집 중단)
_STOP = re.compile(
    r"university|department|school|institute|college|avenue|street|\bst\.|\bemail\b|"
    r"article\s*info|a\s*r\s*t\s*i\s*c\s*l\s*e|abstract|^jel\b|keywords|received|@|^\d",
    re.I,
)


def _norm(s: str) -> str:
    s = re.sub(r"[‐‑‒–—−]", "-", s)  # 각종 하이픈/대시 통일
    return re.sub(r"\s+", " ", s.strip().lower())


def _authors_from_page1(doc: fitz.Document, title: str | None) -> str | None:
    """1페이지에서 (제목 끝 다음 ~ STOP 신호 전)을 저자로 수집.

    제목이 여러 줄로 쪼개질 수 있어, 메타데이터 제목과 줄을 누적 매칭해 제목 끝을 찾는다.
    """
    if not title:
        return None
    lines = [ln.strip() for ln in doc[0].get_text("text").split("\n") if ln.strip()]
    tnorm = _norm(title)

    # 제목 시작/끝 찾기: 누적 concat 이 tnorm 의 prefix 인 동안 제목으로 간주
    title_end = -1
    for i, ln in enumerate(lines):
        if not _norm(ln) or _norm(ln) != tnorm and not tnorm.startswith(_norm(ln)):
            continue
        acc = _norm(ln)
        j = i
        while acc != tnorm and j + 1 < len(lines) and tnorm.startswith(acc):
            j += 1
            acc = _norm(acc + " " + lines[j])
        if acc == tnorm:
            title_end = j
            break
    if title_end < 0:
        return None

    # 제목 끝 다음부터 STOP 전까지 수집(최대 5줄 — 저자 줄이 여러 줄로 쪼개지는 경우)
    collected: list[str] = []
    for ln in lines[title_end + 1 : title_end + 6]:
        if _STOP.search(ln):
            break
        collected.append(ln)
    if not collected:
        return None
    cleaned = _clean_authors(" ".join(collected))
    # 사람 이름다운가(대문자 시작 토큰 2개+, 전부 대문자 이름도 허용) + 제목 조각 아님
    if len(re.findall(r"\b[A-ZÀ-Þ][A-Za-zÀ-ÿ’'.-]+", cleaned)) < 2:
        return None
    if _norm(cleaned) and _norm(cleaned) in tnorm:
        return None
    return cleaned


def _journal_from_subject(subject: str | None) -> str | None:
    """metadata subject 'Journal of X, 147 (2023) ...' → 'Journal of X'."""
    if not subject:
        return None
    s = html.unescape(subject).strip()
    # 첫 콤마 또는 권/연도(숫자) 앞까지가 저널명
    m = re.split(r",|\s\d", s, maxsplit=1)
    name = m[0].strip()
    return name or None


def extract_paper_meta(pdf_path: Path) -> dict:
    """{title, authors, journal} 반환 (없으면 각 항목 None).

    제목: 메타데이터(쓰레기 값 거부) → 1페이지 최대 글꼴 폴백 → None
    (None 이면 build_document 가 첫 heading 블록으로 최종 폴백).
    """
    with fitz.open(pdf_path) as doc:
        md = doc.metadata or {}
        title = _usable_title(html.unescape((md.get("title") or "").strip()))
        if not title:
            title = _title_from_page1(doc)
        journal = _journal_from_subject(md.get("subject"))
        # 저자: 본문 파싱 우선(전체 목록), 실패 시 메타데이터(계정명 류 거부)
        authors = _authors_from_page1(doc, title)
        if not authors:
            meta_author = html.unescape((md.get("author") or "").strip())
            authors = meta_author if _plausible_authors(meta_author) else None
    return {"title": title, "authors": authors, "journal": journal}
