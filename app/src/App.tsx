// 앱 루트 — 라이브러리 ↔ 리더. 전역 설정 모달 + 테마 + PDF 드래그-드롭 추출.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { buildFootnotes, FootnoteContext } from "./render/footnotes";
import { buildCrossRefIndex, CrossRefContext } from "./render/crossrefs";
import { ReadingContext } from "./render/reading";
import { FocusMode, type FocusKind } from "./focus/FocusMode";
import { JumpBackButton } from "./nav/JumpBackButton";
import { resetJumpHistory, undoJump } from "./nav/jump";
import { displayCombo } from "./keys/keymap";
import { Library } from "./library/Library";
import { buildFrontMatter, deSpaceLabel, isSpacedLabel } from "./render/frontmatter";
import type { Block } from "./types";
import { TypographyPanel } from "./typography/TypographyPanel";
import { SelectionTranslate } from "./translate/SelectionTranslate";
import { SourcePeek } from "./sourcepeek/SourcePeek";
import { HighlightLayer } from "./highlight/HighlightLayer";
import { FindBar } from "./search/FindBar";
import { SectionRail } from "./sections/SectionRail";
import { ShortcutsPanel } from "./keys/ShortcutsPanel";
import { useStore, registerFonts } from "./store/useStore";
import { toCssVars } from "./store/typography";
import { isEditableTarget, matchCombo } from "./keys/keymap";

const GEAR = "⚙";

function FrontMatterSection({ items, docId }: { items: Block[]; docId: string }) {
  if (!items.length) return null;
  return (
    <details className="frontmatter">
      <summary>논문 정보 (투고 이력 · 분류 · 키워드)</summary>
      <div className="frontmatter-body">
        {items.map((b) => (
          <BlockRenderer
            key={b.id}
            block={b.text ? { ...b, text: deSpaceLabel(b.text) } : b}
            docId={docId}
          />
        ))}
      </div>
    </details>
  );
}

export function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<PaperDocument | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const [hlPanel, setHlPanel] = useState(false);
  const [sectionPanel, setSectionPanel] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusKind>("off");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openDocId = useRef<string | null>(null);
  // 방향키 페이지 이동: 목표 위치를 누적해 lerp (연타해도 위치가 더해짐, 감속 없음)
  const scrollTarget = useRef<number | null>(null);
  const scrollAnimating = useRef(false);
  const scrollRaf = useRef<number | null>(null);

  const typography = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const keymap = useStore((s) => s.keymap);
  const sectionsCombo = useStore((s) => s.keymap.sections);
  const focusCombo = useStore((s) => s.keymap.focus);
  const cycleFocus = () => setFocusMode((m) => (m === "off" ? "paragraph" : m === "paragraph" ? "sentence" : "off"));
  const bionicCombo = useStore((s) => s.keymap.bionic);
  const sentenceCombo = useStore((s) => s.keymap.sentenceBreak);
  const reading = useStore((s) => s.reading);
  const setReading = useStore((s) => s.setReading);
  const initSession = useStore((s) => s.initSession);

  useEffect(() => {
    initSession();
    refreshDocs();
    const off = window.paperAPI.onDocsChanged(() => {
      refreshDocs();
      if (openDocId.current) reloadOpenDoc(openDocId.current);
    });
    return off;
  }, []);

  // 테마를 문서 전체(라이브러리 포함)에 적용
  useEffect(() => {
    document.body.dataset.theme = typography.theme;
  }, [typography.theme]);

  useEffect(() => {
    if (userFonts.length) registerFonts(userFonts);
  }, [userFonts]);

  // 목차 패널 토글 단축키 (기본 \)
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (matchCombo(e, sectionsCombo)) {
        e.preventDefault();
        setSectionPanel((v) => !v);
      } else if (matchCombo(e, focusCombo)) {
        e.preventDefault();
        cycleFocus();
      } else if (matchCombo(e, bionicCombo)) {
        e.preventDefault();
        setReading({ bionic: !reading.bionic });
      } else if (matchCombo(e, sentenceCombo)) {
        e.preventDefault();
        setReading({ sentenceBreak: !reading.sentenceBreak });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc, sectionsCombo, focusCombo, bionicCombo, sentenceCombo, reading.bionic, reading.sentenceBreak, setReading]);

  // 문서 전환 시 점프 히스토리 초기화 (라이브러리로 나가면 doc=null → 초기화)
  useEffect(() => {
    resetJumpHistory();
  }, [doc?.doc_id]);

  // Cmd/Ctrl+Z — 점프 원위치로 되돌리기(도착지가 화면 밖이어도 동작)
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if ((e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        if (undoJump()) e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc]);

  // 좌/우 방향키로 한 화면씩 슉슉 이동 (→ 다음 · ← 이전). 위/아래는 기본 미세 스크롤 유지.
  // 목표 위치(scrollTarget)를 누적하고 매 프레임 그쪽으로 lerp → 연타하면 위치가 그대로 더해짐
  // (현재 위치 기준 재계산이 아니라, 빠르게/천천히 N번 누르면 같은 곳에 도착).
  useEffect(() => {
    // 포커스 모드일 때는 ←/→ 가 문단/문장 이동에 쓰이므로 페이지 이동은 끔
    if (!doc || settingsOpen || shortcutsOpen || focusMode !== "off") return;
    const LERP = 0.24; // 클수록 빠르게 도착 (~0.4초)
    const STEP = 0.9; // 화면 대비 한 번 이동량(약 10% 겹침)

    const tick = () => {
      const sc = document.querySelector(".reader-scroll") as HTMLElement | null;
      if (!sc || scrollTarget.current == null) {
        scrollAnimating.current = false;
        return;
      }
      const cur = sc.scrollTop;
      const diff = scrollTarget.current - cur;
      if (Math.abs(diff) <= 1) {
        sc.scrollTop = scrollTarget.current;
        scrollAnimating.current = false;
        return;
      }
      sc.scrollTop = cur + diff * LERP;
      scrollRaf.current = requestAnimationFrame(tick);
    };

    const page = (dir: 1 | -1) => {
      const sc = document.querySelector(".reader-scroll") as HTMLElement | null;
      if (!sc) return;
      const max = sc.scrollHeight - sc.clientHeight;
      const step = sc.clientHeight * STEP;
      // 애니메이션 중이 아니면 현재 위치로 재동기화(수동 스크롤 반영), 진행 중이면 목표에 누적
      const base = scrollAnimating.current ? scrollTarget.current ?? sc.scrollTop : sc.scrollTop;
      scrollTarget.current = Math.max(0, Math.min(base + dir * step, max));
      if (!scrollAnimating.current) {
        scrollAnimating.current = true;
        scrollRaf.current = requestAnimationFrame(tick);
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (e.repeat) return; // 누르고 있기=1회(연타로 누적)
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return; // 선택/단축키 보존
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      page(e.key === "ArrowRight" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (scrollRaf.current != null) cancelAnimationFrame(scrollRaf.current);
      scrollAnimating.current = false;
      scrollTarget.current = null;
    };
  }, [doc, settingsOpen, shortcutsOpen, focusMode]);

  function refreshDocs() {
    window.paperAPI?.listDocs().then(setDocs).catch(() => setDocs([]));
  }

  async function reloadOpenDoc(docId: string) {
    const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
    setDoc(d);
  }

  async function open(docId: string) {
    const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
    openDocId.current = docId;
    setDoc(d);
    // 최근 읽음 기록 (state.json 은 와처 밖이라 수동 갱신)
    await window.paperAPI.updateReading(docId, { last_read_at: new Date().toISOString() });
    refreshDocs();
  }

  async function toggleFinished(d: DocSummary) {
    await window.paperAPI.updateReading(d.doc_id, { finished: !d.finished });
    refreshDocs();
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  // 라이브러리 내부 카드 이동 드래그(폴더 정리)는 PDF 추출 드롭과 구분한다.
  const isInternalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("application/x-galpi-move");

  // 드래그-드롭 PDF → 추출 시작
  async function onDrop(e: React.DragEvent) {
    if (isInternalDrag(e)) return;
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) return showToast("PDF 파일만 추출할 수 있습니다.");
    for (const f of files) {
      const path = window.paperAPI.pathForFile(f);
      const res = await window.paperAPI.extractPdf(path);
      if (res.error) showToast(res.error);
      else showToast(`추출 시작: ${f.name} — 곧 라이브러리에 나타납니다.`);
    }
  }

  const openSummary = docs.find((d) => d.doc_id === doc?.doc_id);
  const cssVars = toCssVars(typography) as CSSProperties;
  const footnotes = useMemo(() => (doc ? buildFootnotes(doc.blocks) : null), [doc]);
  const frontMatter = useMemo(() => (doc ? buildFrontMatter(doc.blocks) : null), [doc]);
  const crossRefIndex = useMemo(() => (doc ? buildCrossRefIndex(doc.blocks) : new Map()), [doc]);

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (isInternalDrag(e)) return; e.preventDefault(); setDragging(true); },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragging(false); },
    onDrop,
  };

  return (
    <>
      {doc ? (
        <div className="reader-root" {...dropProps}>
          <header className="reader-bar">
            <button className="back-btn" onClick={() => { openDocId.current = null; setDoc(null); setInspect(false); setHlPanel(false); setSectionPanel(false); setFocusMode("off"); }}>← 라이브러리</button>
            <span className="reader-title">{doc.title ?? doc.doc_id}</span>
            {openSummary?.state === "extracting" && (
              <span className="extract-badge">추출 중 {openSummary.pages_done}/{openSummary.page_count}p</span>
            )}
            <button
              className="icon-action reader-find"
              onClick={() => window.dispatchEvent(new Event("galpi:find-open"))}
              title={`텍스트 검색 · ${displayCombo(keymap.search)}`}
              aria-label="검색"
            >🔎</button>
            <button
              className={`icon-action reader-peek ${inspect ? "on" : ""}`}
              onClick={() => setInspect((v) => !v)}
              title={`원본 대조 — 원본 PDF와 비교 · ${displayCombo(keymap.sourcePeek)} (또는 ⌥+클릭)`}
              aria-label="원본 대조"
              aria-pressed={inspect}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4.5" width="18" height="15" rx="2" />
                <line x1="12" y1="4.5" x2="12" y2="19.5" />
              </svg>
            </button>
            <button
              className={`icon-action reader-focus ${focusMode !== "off" ? "on" : ""}`}
              onClick={cycleFocus}
              title={`포커스 모드: ${focusMode === "off" ? "꺼짐" : focusMode === "paragraph" ? "문단" : "문장"} · ${displayCombo(keymap.focus)}로 전환(문단→문장→끄기) · ←/→ 로 이동`}
              aria-label="포커스 모드"
              aria-pressed={focusMode !== "off"}
            >◎</button>
            <button
              className={`icon-action reader-sections ${sectionPanel ? "on" : ""}`}
              onClick={() => setSectionPanel((v) => !v)}
              title={`목차 — 섹션 이동 · ${displayCombo(keymap.sections)}`}
              aria-label="목차"
              aria-pressed={sectionPanel}
            >☰</button>
            <button className="icon-action reader-gear" onClick={() => setSettingsOpen(true)} title="설정" aria-label="설정">{GEAR}</button>
          </header>
          <div className="reader-body">
            <main className="reader-scroll">
              <CrossRefContext.Provider value={{ index: crossRefIndex, docId: doc.doc_id }}>
              <ReadingContext.Provider value={reading}>
              <FootnoteContext.Provider value={footnotes?.byLabel ?? new Map()}>
                <article className="reader-content" style={cssVars}>
                  {doc.blocks.map((b) => {
                    if (frontMatter && b.id === frontMatter.startId) {
                      return <FrontMatterSection key="fm" items={frontMatter.items} docId={doc.doc_id} />;
                    }
                    if (footnotes?.pulled.has(b.id) || frontMatter?.ids.has(b.id)) return null;
                    if (isSpacedLabel(b.text)) return null; // "a b s t r a c t" 류 장식 라벨 숨김
                    return <BlockRenderer key={b.id} block={b} docId={doc.doc_id} />;
                  })}
                  {openSummary?.state === "extracting" && (
                    <p className="extract-more">⏳ 남은 페이지 추출 중… 완료되는 대로 이어집니다.</p>
                  )}
                  {footnotes && footnotes.ordered.length > 0 && (
                    <details className="footnotes-section">
                      <summary>각주 {footnotes.ordered.length}개</summary>
                      <ol className="footnotes-list">
                        {footnotes.ordered.map((fn) => (
                          <li key={fn.label}>
                            <span className="fn-list-label">{fn.label}</span>
                            <BlockRenderer
                              block={{ id: `fn-${fn.label}`, type: "footnote", page: 0, bbox: null, text: fn.html }}
                              docId={doc.doc_id}
                            />
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </article>
              </FootnoteContext.Provider>
              </ReadingContext.Provider>
              </CrossRefContext.Provider>
            </main>
            <SectionRail
              docId={doc.doc_id}
              blockCount={doc.blocks.length}
              panelOpen={sectionPanel}
              onClose={() => setSectionPanel(false)}
            />
          </div>
          <FindBar docId={doc.doc_id} blockCount={doc.blocks.length} />
          <SelectionTranslate containerSel=".reader-content" />
          <SourcePeek doc={doc} sticky={inspect} onExitSticky={() => setInspect(false)} />
          <HighlightLayer doc={doc} panelOpen={hlPanel} onClosePanel={() => setHlPanel(false)} />
          <FocusMode mode={focusMode} docId={doc.doc_id} blockCount={doc.blocks.length} />
          <JumpBackButton />
        </div>
      ) : (
        <Library
          docs={docs}
          onOpen={open}
          onToggleFinished={toggleFinished}
          onRefresh={refreshDocs}
          onOpenSettings={() => setSettingsOpen(true)}
          dropProps={dropProps}
        />
      )}

      {dragging && (
        <div className="drop-overlay" {...dropProps}>
          <div className="drop-hint">📄 여기에 PDF를 놓으면 추출을 시작합니다</div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {settingsOpen && (
        <TypographyPanel
          onClose={() => setSettingsOpen(false)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
      )}
      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}
