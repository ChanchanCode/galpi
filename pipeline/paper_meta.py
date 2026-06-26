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

    # 제목 끝 다음부터 STOP 전까지 수집(최대 3줄)
    collected: list[str] = []
    for ln in lines[title_end + 1 : title_end + 4]:
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
    """{title, authors, journal} 반환 (없으면 각 항목 None)."""
    with fitz.open(pdf_path) as doc:
        md = doc.metadata or {}
        title = html.unescape((md.get("title") or "").strip()) or None
        journal = _journal_from_subject(md.get("subject"))
        # 저자: 본문 파싱 우선(전체 목록), 실패 시 메타데이터(1저자)
        authors = _authors_from_page1(doc, title)
        if not authors:
            meta_author = html.unescape((md.get("author") or "").strip())
            authors = meta_author or None
    return {"title": title, "authors": authors, "journal": journal}
