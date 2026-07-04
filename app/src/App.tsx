// 앱 루트 — 라이브러리 ↔ 리더. 전역 설정 모달 + 테마 + PDF 드래그-드롭 추출.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { buildFootnotes, FootnoteContext } from "./render/footnotes";
import { buildCrossRefIndex, CrossRefContext } from "./render/crossrefs";
import { buildPageMerges, EMPTY_PAGE_MERGE } from "./render/pagemerge";
import { ReadingContext } from "./render/reading";
import { FocusMode, type FocusKind } from "./focus/FocusMode";
import { JumpBackButton } from "./nav/JumpBackButton";
import { resetJumpHistory, undoJump } from "./nav/jump";
import { useScrollMemory } from "./nav/useScrollMemory";
import { QuickSwitcher } from "./nav/QuickSwitcher";
import { displayCombo } from "./keys/keymap";
import { Library } from "./library/Library";
import { buildFrontMatter, deSpaceLabel, isSpacedLabel } from "./render/frontmatter";
import type { Block } from "./types";
import { TypographyPanel } from "./typography/TypographyPanel";
import { SelectionTranslate } from "./translate/SelectionTranslate";
import { SourcePeek } from "./sourcepeek/SourcePeek";
import { HighlightLayer } from "./highlight/HighlightLayer";
import { NotesLayer } from "./notes/NotesLayer";
import { AnnotationsPanel } from "./annotations/AnnotationsPanel";
import { useAnnotations } from "./annotations/useAnnotations";
import { exportDocToHtml } from "./export/exportHtml";
import { buildAnnotationsMarkdown } from "./annotations/exportMd";
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
  const [annPanel, setAnnPanel] = useState(false);
  const [hlCounts, setHlCounts] = useState<Record<string, number>>({});
  const [sectionPanel, setSectionPanel] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusKind>("off");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const openDocId = useRef<string | null>(null);
  // 방향키 페이지 이동: 목표 위치를 누적해 lerp (연타해도 위치가 더해짐, 감속 없음)
  const scrollTarget = useRef<number | null>(null);
  const scrollAnimating = useRef(false);
  const scrollRaf = useRef<number | null>(null);

  const typography = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const keymap = useStore((s) => s.keymap);
  const openPdfCombo = useStore((s) => s.keymap.openPdf);
  const quickSwitchCombo = useStore((s) => s.keymap.quickSwitch);
  const sectionsCombo = useStore((s) => s.keymap.sections);
  const focusCombo = useStore((s) => s.keymap.focus);
  const cycleFocus = () => setFocusMode((m) => (m === "off" ? "paragraph" : m === "paragraph" ? "sentence" : "off"));
  const bionicCombo = useStore((s) => s.keymap.bionic);
  const sentenceCombo = useStore((s) => s.keymap.sentenceBreak);
  const annotationsCombo = useStore((s) => s.keymap.annotations);
  const reading = useStore((s) => s.reading);
  const setReading = useStore((s) => s.setReading);
  const initSession = useStore((s) => s.initSession);

  // 주석(형광펜 + 메모) 단일 소유 — 리더/패널이 공유. 문서 없으면 빈 상태.
  const ann = useAnnotations(doc?.doc_id ?? null);

  // 읽던 위치 기억/복원 (state.json scroll_anchor)
  useScrollMemory(doc?.doc_id ?? null);

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
      } else if (matchCombo(e, annotationsCombo)) {
        e.preventDefault();
        setAnnPanel((v) => !v);
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
  }, [doc, sectionsCombo, annotationsCombo, focusCombo, bionicCombo, sentenceCombo, reading.bionic, reading.sentenceBreak, setReading]);

  // ⌘O — PDF 파일 선택해 추출 / ⌘P — 퀵 스위처 (라이브러리·리더 어디서나)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchCombo(e, quickSwitchCombo)) {
        e.preventDefault(); // 입력 필드에서도 동작(스위처 안에서 재입력 시 토글)
        setSwitcherOpen((v) => !v);
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (matchCombo(e, openPdfCombo)) {
        e.preventDefault();
        void window.paperAPI.pickPdfs().then(extractPaths);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPdfCombo, quickSwitchCombo]);

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

  // PDF 경로들 추출 시작 — 드래그-드롭과 ⌘O 파일 선택이 공용.
  async function extractPaths(paths: string[]) {
    if (!paths.length) return;
    let ok = 0;
    let firstErr: string | null = null;
    for (const p of paths) {
      const res = await window.paperAPI.extractPdf(p);
      if (res.error) firstErr ??= res.error;
      else ok++;
    }
    if (firstErr) showToast(firstErr);
    else if (ok === 1) showToast("추출 시작 — 곧 라이브러리에 나타납니다.");
    else if (ok > 1) showToast(`${ok}개를 추출 대기열에 추가했습니다 — 컴퓨터 보호를 위해 한 번에 하나씩 처리합니다.`);
  }

  // 현재 문서를 자립형 HTML 로 내보내기(현재 타이포 프리셋 그대로) → AirDrop 용.
  async function exportHtml() {
    if (!doc) return;
    try {
      const res = await exportDocToHtml(doc);
      if (!res.canceled) showToast("내보냈습니다");
    } catch (e) {
      showToast(`내보내기 실패: ${String(e)}`);
    }
  }

  // 주석을 Markdown 으로 클립보드 복사 (주석 패널 버튼)
  async function copyAnnotationsMd() {
    if (!doc) return;
    if (!ann.highlights.length && !ann.notes.length) return showToast("형광펜·메모 없음");
    const md = buildAnnotationsMarkdown(doc.title ?? doc.doc_id, ann.highlights, ann.notes);
    await navigator.clipboard.writeText(md);
    showToast("주석을 Markdown으로 복사했습니다");
  }

  // 드래그-드롭 PDF → 추출 시작.
  // 오버레이가 마운트되며 원래 요소에 dragleave 가 튀는 플리커를 피하려고
  // window 레벨에서 enter/leave 깊이를 세고, 오버레이는 pointer-events:none 으로 둔다.
  // 라이브러리 내부 카드 이동 드래그(application/x-galpi-move)는 제외.
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (e: DragEvent) => {
      const t = e.dataTransfer?.types;
      return !!t && t.includes("Files") && !t.includes("application/x-galpi-move");
    };
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); // drop 허용
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.pdf$/i.test(f.name));
      if (!files.length) return showToast("PDF 파일만 추출할 수 있습니다.");
      await extractPaths(files.map((f) => window.paperAPI.pathForFile(f)));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const openSummary = docs.find((d) => d.doc_id === doc?.doc_id);
  const cssVars = toCssVars(typography) as CSSProperties;
  const footnotes = useMemo(() => (doc ? buildFootnotes(doc.blocks) : null), [doc]);
  const frontMatter = useMemo(() => (doc ? buildFrontMatter(doc.blocks) : null), [doc]);
  const crossRefIndex = useMemo(() => (doc ? buildCrossRefIndex(doc.blocks) : new Map()), [doc]);
  // 페이지 경계에서 끊긴 문단 잇기 — 각주/프론트매터는 제외하고 인접 판정.
  const pageMerge = useMemo(() => {
    if (!doc) return EMPTY_PAGE_MERGE;
    const hidden = new Set<string>(footnotes?.pulled ?? []);
    if (frontMatter) { frontMatter.ids.forEach((id) => hidden.add(id)); if (frontMatter.startId) hidden.add(frontMatter.startId); }
    return buildPageMerges(doc.blocks, hidden);
  }, [doc, footnotes, frontMatter]);

  return (
    <>
      {doc ? (
        <div className="reader-root">
          <header className="reader-bar">
            <button className="back-btn" onClick={() => { openDocId.current = null; setDoc(null); setInspect(false); setAnnPanel(false); setSectionPanel(false); setFocusMode("off"); }}>← 라이브러리</button>
            <span className="reader-title">{doc.title ?? doc.doc_id}</span>
            {openSummary?.state === "extracting" && (
              <span className="extract-badge">추출 중 {openSummary.pages_done}/{openSummary.page_count}p</span>
            )}
            <button
              className="icon-action reader-find"
              onClick={() => window.dispatchEvent(new Event("galpi:find-open"))}
              data-tip={`검색 · ${displayCombo(keymap.search)}`}
              aria-label="검색"
            >🔎</button>
            <button
              className={`icon-action reader-peek ${inspect ? "on" : ""}`}
              onClick={() => setInspect((v) => !v)}
              data-tip={`원본 대조 · ${displayCombo(keymap.sourcePeek)}`}
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
              data-tip={`포커스 · ${displayCombo(keymap.focus)}`}
              aria-label="포커스"
              aria-pressed={focusMode !== "off"}
            >◎</button>
            <button
              className={`icon-action reader-sections ${sectionPanel ? "on" : ""}`}
              onClick={() => setSectionPanel((v) => !v)}
              data-tip={`목차 · ${displayCombo(keymap.sections)}`}
              aria-label="목차"
              aria-pressed={sectionPanel}
            >☰</button>
            <button
              className={`icon-action reader-ann ${annPanel ? "on" : ""}`}
              onClick={() => setAnnPanel((v) => !v)}
              data-tip={`주석 · ${displayCombo(keymap.annotations)}`}
              aria-label="주석"
              aria-pressed={annPanel}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5h12M4 10h12M4 15h7" />
                <path d="M18.5 13.5l2 2-4.5 4.5H14v-2z" />
              </svg>
            </button>
            <button
              className="icon-action reader-export"
              onClick={exportHtml}
              data-tip="내보내기"
              aria-label="내보내기"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12" />
                <path d="M8 7l4-4 4 4" />
                <path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" />
              </svg>
            </button>
            <button className="icon-action reader-gear" onClick={() => setSettingsOpen(true)} data-tip="설정" aria-label="설정">{GEAR}</button>
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
                    if (pageMerge.absorbed.has(b.id)) return null; // 앞 문단에 흡수된 페이지 분리 조각
                    if (isSpacedLabel(b.text)) return null; // "a b s t r a c t" 류 장식 라벨 숨김
                    const ov = pageMerge.textOverride.get(b.id);
                    let block = ov != null ? { ...b, text: ov } : b; // 페이지 넘긴 문단 합치기
                    const fe = b.type === "formula" ? ann.formulaEdits[b.id] : undefined;
                    if (fe != null) block = { ...block, latex: fe }; // 수동 고친 LaTeX (§11-10)
                    return <BlockRenderer key={b.id} block={block} docId={doc.doc_id} />;
                  })}
                  {openSummary?.state === "extracting" && (
                    <p className="extract-more">⏳ 남은 페이지 추출 중… 완료되는 대로 이어집니다.</p>
                  )}
                  {footnotes && footnotes.ordered.length > 0 && (
                    <details className="footnotes-section">
                      <summary>각주 {footnotes.ordered.length}개</summary>
                      <ol className="footnotes-list">
                        {footnotes.ordered.map((fn) => (
                          <li key={fn.label} data-fn-item={fn.label}>
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
          <SourcePeek
            doc={doc}
            sticky={inspect}
            onExitSticky={() => setInspect(false)}
            formulaEdits={ann.formulaEdits}
            onEditFormula={ann.setFormulaEdit}
          />
          <HighlightLayer doc={doc} rules={ann.highlights} updateRules={ann.updateHighlights} onCounts={setHlCounts} />
          <NotesLayer doc={doc} notes={ann.notes} updateNotes={ann.updateNotes} />
          {annPanel && (
            <AnnotationsPanel
              highlights={ann.highlights}
              notes={ann.notes}
              counts={hlCounts}
              updateHighlights={ann.updateHighlights}
              updateNotes={ann.updateNotes}
              onCopyMd={copyAnnotationsMd}
              onClose={() => setAnnPanel(false)}
            />
          )}
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
        />
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-hint">📄 여기에 PDF를 놓으면 추출을 시작합니다</div>
        </div>
      )}
      {switcherOpen && (
        <QuickSwitcher
          docs={docs}
          currentId={doc?.doc_id ?? null}
          onOpen={(id) => void open(id)}
          onClose={() => setSwitcherOpen(false)}
        />
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
