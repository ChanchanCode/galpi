// 앱 루트 — 라이브러리 ↔ 리더. 전역 설정 모달 + 테마 + PDF 드래그-드롭 추출.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { buildFootnotes } from "./render/footnotes";
import { FootnoteContext } from "./render/footnoteContext";
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
import { collectTrBlocks } from "./translate/trBlocks";
import { useTranslation } from "./translate/useTranslation";
import { TranslateColumn } from "./translate/TranslateColumn";
import { SourceView } from "./translate/SourceView";
import { TranslatePopover } from "./translate/TranslatePopover";
import { TrCardMenu } from "./translate/TrCardMenu";
import { docScaleStyle, useCanvas } from "./translate/useCanvas";
import { ZoomBar } from "./translate/ZoomBar";
import { SourcePeek } from "./sourcepeek/SourcePeek";
import { HighlightLayer } from "./highlight/HighlightLayer";
import { NotesLayer } from "./notes/NotesLayer";
import { AnnotationsPanel } from "./annotations/AnnotationsPanel";
import { useAnnotations } from "./annotations/useAnnotations";
import { exportDocToHtml } from "./export/exportHtml";
import { PdfExportDialog } from "./export/PdfExportDialog";
import { buildAnnotationsMarkdown } from "./annotations/exportMd";
import { FindBar } from "./search/FindBar";
import { SectionRail } from "./sections/SectionRail";
import { ShortcutsPanel } from "./keys/ShortcutsPanel";
import { useStore, registerFonts } from "./store/useStore";
import { toCssVars } from "./store/typography";
import { isEditableTarget, matchCombo } from "./keys/keymap";
import { ChatPanel } from "./chat/ChatPanel";
import { onChat } from "./chat/chatBus";
import { SelectionToolbar } from "./selection/SelectionToolbar";
import { RegionCapture } from "./selection/RegionCapture";
import { FigureMenu } from "./selection/FigureMenu";
import { MIME_ATTACH, MIME_QUOTE } from "./selection/quote";

// 채팅 패널 안에 포커스가 있을 때(버튼·목록) 본문 단축키가 새지 않게. 입력칸은 isEditableTarget 이 이미 막는다.
const EMPTY_FOOTNOTES = new Map();

const inChatPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest(".chat-panel");

// 상단바 아이콘 공통 속성 — 획 굵기·라운딩을 한 곳에서 맞춘다(제각각이면 지저분해 보인다).
const ICO = {
  width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true,
};

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
  const [trPop, setTrPop] = useState(false); // 번역 팝오버
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  // AI 채팅 패널 열림. 문서를 닫아도 유지 — 첫 마운트 때 ChatPanel 이 chatLayout.open 으로 맞춘다.
  const [chatOpen, setChatOpen] = useState(false);
  const trBtnRef = useRef<HTMLButtonElement>(null);
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
  const trDocCombo = useStore((s) => s.keymap.translateDoc);
  const srcViewCombo = useStore((s) => s.keymap.sourceView);
  const chatCombo = useStore((s) => s.keymap.chat);
  const reading = useStore((s) => s.reading);
  const setReading = useStore((s) => s.setReading);
  const initSession = useStore((s) => s.initSession);

  // 주석(형광펜 + 메모) 단일 소유 — 리더/패널이 공유. 문서 없으면 빈 상태.
  const ann = useAnnotations(doc?.doc_id ?? null);

  // 읽던 위치 기억/복원 (state.json scroll_anchor)
  useScrollMemory(doc?.doc_id ?? null);

  // ── 문서 파생 (블록 인덱스·병합·번역 대상) ──────────────────────
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

  // 번역 대상 블록 — App 이 실제로 그리는 것과 1:1 이어야 카드가 안 뜬다.
  const trBlocks = useMemo(() => {
    if (!doc) return [];
    return collectTrBlocks(doc, {
      pulled: footnotes?.pulled ?? new Set<string>(),
      frontIds: frontMatter?.ids ?? new Set<string>(),
      frontStartId: frontMatter?.startId ?? null,
      merge: pageMerge,
    });
  }, [doc, footnotes, frontMatter, pageMerge]);
  const tr = useTranslation(doc?.doc_id ?? null, doc?.title ?? doc?.doc_id ?? "", trBlocks);
  // 본문 블록 목록은 **문서가 바뀔 때만** 다시 만든다. 번역 토글·채팅 열기처럼 App 상태만 바뀌는 렌더에서
  // 수백 블록(KaTeX 포함)을 다시 그리면 T 를 눌러도 카드가 0.3초 늦게 떴다(사용자 신고 · 실측 330ms).
  const crossRefValue = useMemo(() => ({ index: crossRefIndex, docId: doc?.doc_id ?? "" }), [crossRefIndex, doc?.doc_id]);
  const articleBlocks = useMemo(() => {
    if (!doc) return null;
    return doc.blocks.map((b) => {
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
    });
  }, [doc, frontMatter, footnotes, pageMerge, ann.formulaEdits]);

  // 번역을 켰는데 아직 하나도 번역이 안 됐으면 시작 팝업을 띄운다.
  // 이미 번역된 문서에서는 T 가 그냥 컬럼을 켜고 끈다 — 재번역은 카드 우클릭으로.
  useEffect(() => {
    if (!tr.on) return setTrPop(false);
    if (tr.running) return setTrPop(true);
    if (tr.plan && tr.plan.cached === 0 && tr.plan.pending > 0) setTrPop(true);
  }, [tr.on, tr.running, tr.plan]);

  // 보기 A 도 팬/줌 캔버스를 쓴다(보기 B 와 같은 훅). 글자 위 드래그는 선택으로 남긴다.
  // 무대 실제 폭(본문 폭 + 간격 + 번역 컬럼). 번역 컬럼을 넓히면 캔버스보다 넓어지고,
  // 남는 만큼은 팬으로 본다 — 논문 폭을 줄이지 않는다.
  const stageW = tr.on && tr.view === "reflow" ? typography.contentMaxWidth + 26 + tr.width + 18 : 0;
  const rd = useCanvas(!!doc && tr.view === "reflow", ".reader-content, .tr-col", stageW);
  // 원본 모드 캔버스도 **여기서** 만든다. SourceView 안에 두면 보기를 오갈 때마다
  // 컴포넌트가 다시 마운트돼 사용자가 맞춰 둔 배율이 1 로 돌아간다(사용자 신고).
  const [srcDocW, setSrcDocW] = useState(0);
  const srcCv = useCanvas(!!doc && tr.view === "source", ".trhalf", srcDocW);

  // 문서를 바꾸면 두 캔버스 모두 원위치 — 앞 문서에서 확대해 둔 채로 열리면 당황스럽다.
  useEffect(() => {
    rd.reset();
    srcCv.reset();
    setSrcDocW(0);
  }, [doc?.doc_id]);

  // 번역 컬럼을 **여는 순간** 전체가 한 화면에 들어오게 맞춘다.
  // 본문 폭은 옵션 값을 지키므로(고정), 안 들어오면 배율로 줄이는 게 답이다.
  // 여는 시점에만 건다 — 폭 손잡이를 끌 때마다 배율이 튀면 안 된다.
  const trWasOn = useRef(false);
  useEffect(() => {
    if (tr.on && !trWasOn.current && tr.view === "reflow" && stageW) rd.fit(stageW);
    trWasOn.current = tr.on;
  }, [tr.on, tr.view, stageW, rd]);

  // 블록 높이를 바꾸는 것들 — 바뀌면 카드 행 정렬을 다시 잰다(D20). 배율도 포함.
  const relayoutKey = `${JSON.stringify(typography)}|${reading.bionic}|${reading.sentenceBreak}|${focusMode}|${rd.z}|${rd.baseW}`;

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

  // '문장 줄바꿈'은 본문뿐 아니라 번역 컬럼에도 걸린다 — 표식만 올리고 CSS 가 받는다.
  // (번역 문장은 이미 `.tr-s` 로 쪼개져 있어 display 만 바꾸면 된다.)
  useEffect(() => {
    if (reading.sentenceBreak) document.body.dataset.sentenceBreak = "on";
    else delete document.body.dataset.sentenceBreak;
  }, [reading.sentenceBreak]);

  useEffect(() => {
    if (userFonts.length) registerFonts(userFonts);
  }, [userFonts]);

  // 목차 패널 토글 단축키 (기본 \)
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || inChatPanel(e.target)) return;
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
      } else if (matchCombo(e, trDocCombo)) {
        e.preventDefault();
        tr.toggle();
      } else if (matchCombo(e, srcViewCombo)) {
        e.preventDefault();
        tr.toggleView();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc, sectionsCombo, annotationsCombo, focusCombo, bionicCombo, sentenceCombo, trDocCombo, srcViewCombo, reading.bionic, reading.sentenceBreak, setReading, tr.toggle, tr.toggleView]);

  // AI 채팅 — ⌘L 은 채팅 입력칸 안에서도 먹어야 닫을 수 있다(수식 키 조합이라 타이핑과 안 겹친다).
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matchCombo(e, chatCombo)) return;
      e.preventDefault();
      setChatOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc, chatCombo]);

  // 본문 쪽(선택 툴바·그림 메뉴·캡처)이 버스로 보내면 패널을 연다. 내용(quote/attach/ask)은 ChatPanel 이 받는다.
  useEffect(
    () =>
      onChat((e) => {
        if (e.type === "toggle") setChatOpen((v) => !v);
        else setChatOpen(true);
      }),
    [],
  );

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
      if (isEditableTarget(e.target) || inChatPanel(e.target)) return;
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
      if (isEditableTarget(e.target) || inChatPanel(e.target)) return;
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
    // agy 웜 스페어를 미리 데운다 — 첫 번역 TTFT 가 6초에서 1.4초로 줄어든다.
    // 실패해도 무시(agy 없거나 미로그인이면 그냥 안 된다). 5분 유휴면 알아서 정리된다.
    void window.paperAPI.agyPrewarm().catch(() => {});
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
  // 채팅으로 끄는 인용·그림(§2.2)도 제외 — 그림 <img> 끌기는 Chromium 이 "Files" 를 같이 싣는다.
  // 채팅 패널 위 드롭은 패널이 받는다(패널이 전파를 끊지만, 대상 검사로 한 번 더 막는다).
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (e: DragEvent) => {
      const t = e.dataTransfer?.types;
      if (!t || !t.includes("Files")) return false;
      if (t.includes("application/x-galpi-move") || t.includes(MIME_QUOTE) || t.includes(MIME_ATTACH)) return false;
      return !inChatPanel(e.target);
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

  return (
    <>
      {doc ? (
        <div className="reader-root">
          <header className="reader-bar">
            <button
              className="back-btn"
              onClick={() => { openDocId.current = null; setDoc(null); setPdfExportOpen(false); setInspect(false); setAnnPanel(false); setSectionPanel(false); setFocusMode("off"); }}
              data-tip="라이브러리"
              aria-label="라이브러리"
            >←</button>
            {/* 제목 = 목차 버튼. 상단바에서 버튼 하나를 뺀다. */}
            <button
              className={`reader-title ${sectionPanel ? "on" : ""}`}
              onClick={() => setSectionPanel((v) => !v)}
              data-tip={`목차 · ${displayCombo(keymap.sections)}`}
              aria-pressed={sectionPanel}
            >{doc.title ?? doc.doc_id}</button>
            {openSummary?.state === "extracting" && (
              <span className="extract-badge">추출 중 {openSummary.pages_done}/{openSummary.page_count}p</span>
            )}
            <span className="bar-gap" />
            <button
              className="icon-action"
              onClick={() => window.dispatchEvent(new Event("galpi:find-open"))}
              data-tip={`검색 · ${displayCombo(keymap.search)}`}
              aria-label="검색"
            >
              <svg {...ICO}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
            </button>
            <button
              className={`icon-action ${inspect ? "on" : ""}`}
              onClick={() => setInspect((v) => !v)}
              data-tip={`원본 크롭 · ${displayCombo(keymap.sourcePeek)}`}
              aria-label="원본 크롭"
              aria-pressed={inspect}
            >
              <svg {...ICO}><rect x="4" y="3.5" width="16" height="17" rx="2" /><circle cx="12" cy="11" r="3.5" /><path d="M14.6 13.6L17 16" /></svg>
            </button>
            <button
              className={`icon-action ${focusMode !== "off" ? "on" : ""}`}
              onClick={cycleFocus}
              data-tip={`포커스 · ${displayCombo(keymap.focus)}`}
              aria-label="포커스"
              aria-pressed={focusMode !== "off"}
            >
              <svg {...ICO}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.6" /></svg>
            </button>
            <span className="bar-sep" />
            {/* 번역 — 누르면 팝오버가 열린다(백엔드·견적·시작/중단). */}
            <button
              ref={trBtnRef}
              className={`icon-action reader-tr ${tr.on ? "on" : ""}`}
              onClick={() => { tr.toggle(); setTrPop(false); }}
              data-tip={`번역 · ${displayCombo(keymap.translateDoc)}`}
              aria-label="번역"
              aria-pressed={tr.on}
            >T</button>
            {/* 보기 전환은 번역과 무관하게 늘 쓸 수 있다 — 원문 지면만 보고 싶을 때가 있다. */}
            <button
              className={`icon-action ${tr.view === "source" ? "on" : ""}`}
              onClick={tr.toggleView}
              data-tip={`원본 모드 · ${displayCombo(keymap.sourceView)}`}
              aria-label="원본 모드"
              aria-pressed={tr.view === "source"}
            >
              <svg {...ICO}><rect x="3.5" y="4" width="7" height="16" rx="1.4" /><path d="M14 7h6.5M14 11h6.5M14 15h4.5" /></svg>
            </button>
            <button
              className={`icon-action ${chatOpen ? "on" : ""}`}
              onClick={() => setChatOpen((v) => !v)}
              data-tip={`AI 채팅 · ${displayCombo(keymap.chat)}`}
              aria-label="AI 채팅"
              aria-pressed={chatOpen}
            >
              <svg {...ICO}><path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z" /></svg>
            </button>
            <span className="bar-sep" />
            <button
              className="icon-action"
              onClick={() => { setTrPop(false); setPdfExportOpen(true); }}
              data-tip="원문 + 번역 PDF 저장"
              aria-label="내보내기"
            >
              <svg {...ICO}><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6" /></svg>
            </button>
            <button className="icon-action" onClick={() => setSettingsOpen(true)} data-tip="설정" aria-label="설정">
              <svg {...ICO}>
                <circle cx="12" cy="12" r="3.1" />
                <path d="M19.1 14.6a1.5 1.5 0 0 0 .3 1.65l.05.06a1.85 1.85 0 1 1-2.62 2.62l-.06-.06a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.91 1.37V20a1.85 1.85 0 0 1-3.7 0v-.08a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.06.06a1.85 1.85 0 1 1-2.62-2.62l.05-.06a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.91H4a1.85 1.85 0 0 1 0-3.7h.08a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.06a1.85 1.85 0 1 1 2.62-2.62l.06.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .91-1.37V4a1.85 1.85 0 0 1 3.7 0v.08a1.5 1.5 0 0 0 .91 1.37 1.5 1.5 0 0 0 1.65-.3l.06-.05a1.85 1.85 0 1 1 2.62 2.62l-.05.06a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.91H20a1.85 1.85 0 0 1 0 3.7h-.08a1.5 1.5 0 0 0-1.37.91z" />
              </svg>
            </button>
          </header>
          <div className="reader-body">
            {/* 본문·목차·주석 패널은 .reader-main 안 — 도킹된 채팅 패널이 옆자리를 차지해도
                오버레이 패널(position:absolute)이 채팅을 덮지 않고 본문 기준으로 붙는다. */}
            <div className="reader-main">
            <main className="reader-scroll" style={cssVars}>
              <CrossRefContext.Provider value={crossRefValue}>
              <ReadingContext.Provider value={reading}>
              <FootnoteContext.Provider value={footnotes?.byLabel ?? EMPTY_FOOTNOTES}>
                {/* 번역 컬럼은 .reader-content **밖**이다(D19) — 안에 넣으면 형광펜·검색·
                    내보내기 등 .reader-content 를 잡는 모듈 10곳이 한국어를 본문으로 먹는다. */}
                <div className="rd-canvas" ref={rd.canvasRef} onPointerDown={rd.onPointerDown}>
                <div className="src-pan" ref={rd.panRef}>
                <div className="src-shift" ref={rd.shiftRef}>
                <div className="src-doc" style={{ width: Math.max(rd.baseW, stageW) || undefined, ...docScaleStyle(rd.z) }}>
                <div
                  className="reader-stage"
                  data-tr={tr.on ? "on" : undefined}
                  data-view={tr.view}
                  style={{
                    ...cssVars,
                    width: stageW || undefined,
                    // 표·수식이 두 컬럼 전체 기준으로 가운데 정렬되도록 컬럼 폭을 CSS 에 알려 준다.
                    ["--tr-col-w" as string]: tr.on ? `${tr.width}px` : "0px",
                  }}
                >
                <article className="reader-content" style={cssVars}>
                  {articleBlocks}
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
                {tr.on && tr.view === "reflow" && (
                  <TranslateColumn
                    blocks={trBlocks}
                    entries={tr.entries}
                    width={tr.width}
                    onWidth={tr.setWidth}
                    redoing={tr.redoing}
                    relayoutKey={relayoutKey}
                  />
                )}
                </div>
                </div>
                </div>
                </div>
                {/* 100% 일 땐 안 띄운다 — 평소 읽을 때 화면에 뜬 UI 를 늘리지 않는다. */}
                {tr.view === "reflow" && rd.zoomVisible && (
                  <ZoomBar z={rd.z} onZoom={rd.zoomBy} onReset={rd.reset} />
                )}
                </div>
              </FootnoteContext.Provider>
              </ReadingContext.Provider>
              </CrossRefContext.Provider>
              {/* 보기 B — 왼쪽만 원본 지면으로 갈린다(D9). .reader-content 는 CSS 로 숨길 뿐
                  언마운트하지 않는다 — 형광펜·메모·검색이 잡고 있는 컨테이너다. */}
              {tr.view === "source" && (
                <SourceView
                  doc={doc}
                  cv={srcCv}
                  onDocW={setSrcDocW}
                  showTr={tr.on}
                  blocks={trBlocks}
                  entries={tr.entries}
                  width={tr.width}
                  onWidth={tr.setWidth}
                  redoing={tr.redoing}
                  merge={pageMerge}
                />
              )}
            </main>
            <SectionRail
              docId={doc.doc_id}
              blockCount={doc.blocks.length}
              panelOpen={sectionPanel}
              onClose={() => setSectionPanel(false)}
            />
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
            </div>
            <ChatPanel doc={doc} open={chatOpen} onOpenChange={setChatOpen} viewMode={tr.view} />
          </div>
          {tr.on && <TrCardMenu onRedoBlock={tr.retranslate} onRedoAll={() => tr.start(true)} />}
          {trPop && (
            <TranslatePopover
              anchor={trBtnRef}
              plan={tr.plan}
              progress={tr.progress}
              running={tr.running}
              onStart={() => tr.start(false)}
              onCancel={tr.cancel}
              onClose={() => setTrPop(false)}
            />
          )}
          <FindBar docId={doc.doc_id} blockCount={doc.blocks.length} />
          <SelectionTranslate
            containerSel=".reader-content"
            docId={doc.doc_id}
            docTitle={doc.title ?? doc.doc_id}
          />
          {/* 포털로 body 에 그리지만 React 이벤트는 React 조상으로 버블한다 — .rd-canvas 밖에 둬야
              툴바 클릭이 캔버스 onPointerDown(패닝)으로 새지 않는다. */}
          <SelectionToolbar docId={doc.doc_id} docTitle={doc.title ?? doc.doc_id} />
          <RegionCapture docId={doc.doc_id} />
          <FigureMenu doc={doc} />
          <SourcePeek
            doc={doc}
            sticky={inspect}
            onExitSticky={() => setInspect(false)}
            formulaEdits={ann.formulaEdits}
            onEditFormula={ann.setFormulaEdit}
          />
          <HighlightLayer doc={doc} rules={ann.highlights} updateRules={ann.updateHighlights} onCounts={setHlCounts} />
          <NotesLayer doc={doc} notes={ann.notes} updateNotes={ann.updateNotes} />
          <FocusMode mode={focusMode} docId={doc.doc_id} blockCount={doc.blocks.length} />
          <JumpBackButton />
          {pdfExportOpen && <PdfExportDialog key={doc.doc_id} doc={doc} blocks={trBlocks} entries={tr.entries}
            merge={pageMerge} typography={typography} translationWidth={tr.width}
            extracting={openSummary?.state === "extracting" || doc.pages.length < doc.page_count}
            onClose={() => setPdfExportOpen(false)} onSaved={() => showToast("원문 + 번역 PDF를 저장했습니다")}
            onHtml={() => void exportHtml()} />}
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
