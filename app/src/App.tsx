// 앱 루트 — 라이브러리 ↔ 리더. 전역 설정 모달 + 테마 + PDF 드래그-드롭 추출.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { TypographyPanel } from "./typography/TypographyPanel";
import { SelectionTranslate } from "./translate/SelectionTranslate";
import { useStore, registerFonts } from "./store/useStore";
import { toCssVars } from "./store/typography";

const GEAR = "⚙";

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

export function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<PaperDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const openDocId = useRef<string | null>(null);

  const typography = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
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

  function refreshDocs() {
    window.paperAPI?.listDocs().then(setDocs).catch(() => setDocs([]));
  }

  async function reloadOpenDoc(docId: string) {
    const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
    setDoc(d);
  }

  async function open(docId: string) {
    setLoading(true);
    try {
      const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
      openDocId.current = docId;
      setDoc(d);
      // 최근 읽음 기록 (state.json 은 와처 밖이라 수동 갱신)
      await window.paperAPI.updateReading(docId, { last_read_at: new Date().toISOString() });
      refreshDocs();
    } finally {
      setLoading(false);
    }
  }

  async function toggleFinished(d: DocSummary) {
    await window.paperAPI.updateReading(d.doc_id, { finished: !d.finished });
    refreshDocs();
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  // 드래그-드롭 PDF → 추출 시작
  async function onDrop(e: React.DragEvent) {
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

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragging(true); },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragging(false); },
    onDrop,
  };

  return (
    <>
      {doc ? (
        <div className="reader-root" {...dropProps}>
          <header className="reader-bar">
            <button className="back-btn" onClick={() => { openDocId.current = null; setDoc(null); }}>← 라이브러리</button>
            <span className="reader-title">{doc.title ?? doc.doc_id}</span>
            {openSummary?.state === "extracting" && (
              <span className="extract-badge">추출 중 {openSummary.pages_done}/{openSummary.page_count}p</span>
            )}
            <button className="icon-action reader-gear" onClick={() => setSettingsOpen(true)} title="읽기 설정" aria-label="설정">{GEAR}</button>
          </header>
          <div className="reader-body">
            <main className="reader-scroll">
              <article className="reader-content" style={cssVars}>
                {doc.blocks.map((b) => (
                  <BlockRenderer key={b.id} block={b} docId={doc.doc_id} />
                ))}
                {openSummary?.state === "extracting" && (
                  <p className="extract-more">⏳ 남은 페이지 추출 중… 완료되는 대로 이어집니다.</p>
                )}
              </article>
            </main>
          </div>
          <SelectionTranslate containerSel=".reader-content" />
        </div>
      ) : (
        <div className="library-root" {...dropProps}>
          <header className="library-bar">
            <h1>Paper Reader</h1>
            <div className="bar-actions">
              <button className="icon-action" onClick={refreshDocs} title="새로고침" aria-label="새로고침">↻</button>
              <button className="icon-action" onClick={() => setSettingsOpen(true)} title="읽기 설정" aria-label="설정">{GEAR}</button>
            </div>
          </header>
          <p className="hint">
            PDF를 이 창에 끌어다 놓으면 추출이 시작됩니다. (또는 <code>pipeline/extract.py</code>)
          </p>
          {loading && <p>여는 중…</p>}
          {docs.length === 0 ? (
            <p className="empty">아직 추출된 문서가 없습니다. PDF를 끌어다 놓아 보세요.</p>
          ) : (
            <ul className="doc-list">
              {docs.map((d) => {
                const sub = [d.authors, d.journal].filter(Boolean).join(" · ");
                const read = relTime(d.last_read_at);
                return (
                  <li key={d.doc_id}>
                    <div className={`doc-card ${d.finished ? "is-finished" : ""}`} onClick={() => open(d.doc_id)}>
                      <div className="doc-main">
                        <span className="doc-title">{d.title ?? d.doc_id}</span>
                        {sub && <span className="doc-sub">{sub}</span>}
                        <span className="doc-foot">
                          {d.state === "extracting"
                            ? `추출 중 ${d.pages_done}/${d.page_count}p`
                            : `${d.page_count}p`}
                          {read && <span className="doc-dot">·</span>}
                          {read && <span>{read} 읽음</span>}
                        </span>
                      </div>
                      <button
                        className={`finish-toggle ${d.finished ? "on" : ""}`}
                        onClick={(e) => { e.stopPropagation(); toggleFinished(d); }}
                        title={d.finished ? "완독 해제" : "완독으로 표시"}
                      >
                        {d.finished ? "✓ 완독" : "완독"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {dragging && (
        <div className="drop-overlay" {...dropProps}>
          <div className="drop-hint">📄 여기에 PDF를 놓으면 추출을 시작합니다</div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {settingsOpen && <TypographyPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
