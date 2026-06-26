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


# 저자 줄 다음에 나오면 본문/소속 시작으로 간주하는 신호
_STOP = re.compile(
    r"university|department|school|institute|avenue|street|\bst\.|\bemail\b|"
    r"article\s*info|a\s*r\s*t\s*i\s*c\s*l\s*e|abstract|@|^\d",
    re.I,
)


def _authors_from_page1(doc: fitz.Document, title: str | None) -> str | None:
    """1페이지에서 제목 다음 줄(저자)을 찾아 정리."""
    lines = [ln.strip() for ln in doc[0].get_text("text").split("\n")]
    lines = [ln for ln in lines if ln]
    # 제목 줄 위치 찾기
    start = 0
    if title:
        tnorm = title.lower()
        for i, ln in enumerate(lines):
            if ln.lower().startswith(tnorm[:24]):
                start = i + 1
                break
    # 제목 다음 첫 줄이 저자(소속/abstract 신호가 아니어야)
    for ln in lines[start : start + 4]:
        if _STOP.search(ln):
            break
        cleaned = _clean_authors(ln)
        # 사람 이름다운가: 대문자로 시작하는 토큰이 2개 이상
        if len(re.findall(r"[A-Z][a-zà-ÿ]+", cleaned)) >= 2:
            return cleaned
    return None


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
