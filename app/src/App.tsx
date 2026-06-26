// 앱 루트 — 라이브러리 ↔ 리더. Phase 3 타이포 + 페이지 스트리밍 라이브 갱신 + 번역.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { TypographyPanel } from "./typography/TypographyPanel";
import { SelectionTranslate } from "./translate/SelectionTranslate";
import { useStore, registerFonts } from "./store/useStore";
import { toCssVars } from "./store/typography";

export function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<PaperDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const openDocId = useRef<string | null>(null);

  const typography = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const initSession = useStore((s) => s.initSession);
  const loadDocState = useStore((s) => s.loadDocState);

  useEffect(() => {
    initSession();
    refreshDocs();
    // 추출 진행/완료 라이브 통지: 라이브러리 + 열린 문서 갱신(페이지 스트리밍)
    const off = window.paperAPI.onDocsChanged(() => {
      refreshDocs();
      if (openDocId.current) reloadOpenDoc(openDocId.current);
    });
    return off;
  }, []);

  useEffect(() => {
    if (userFonts.length) registerFonts(userFonts);
  }, [userFonts]);

  function refreshDocs() {
    window.paperAPI?.listDocs().then(setDocs).catch(() => setDocs([]));
  }

  // 열린 문서를 다시 읽어 새 블록 이어붙임(스크롤은 안정 key 로 유지)
  async function reloadOpenDoc(docId: string) {
    const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
    setDoc(d);
  }

  async function open(docId: string) {
    setLoading(true);
    try {
      const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
      await loadDocState(docId);
      openDocId.current = docId;
      setDoc(d);
    } finally {
      setLoading(false);
    }
  }

  function close() {
    openDocId.current = null;
    setDoc(null);
  }

  const openSummary = docs.find((d) => d.doc_id === doc?.doc_id);

  if (doc) {
    const extracting = openSummary?.state === "extracting";
    return (
      <div className="reader-root" data-theme={typography.theme}>
        <header className="reader-bar">
          <button className="back-btn" onClick={close}>← 라이브러리</button>
          <span className="reader-title">{doc.title ?? doc.doc_id}</span>
          {extracting && (
            <span className="extract-badge">
              추출 중 {openSummary?.pages_done}/{openSummary?.page_count}p
            </span>
          )}
          <button className="bar-btn" onClick={() => setPanelOpen((v) => !v)}>
            {panelOpen ? "설정 닫기" : "Aa 읽기 설정"}
          </button>
        </header>
        <div className="reader-body">
          <main className="reader-scroll">
            <article className="reader-content" style={toCssVars(typography) as CSSProperties}>
              {doc.blocks.map((b) => (
                <BlockRenderer key={b.id} block={b} docId={doc.doc_id} />
              ))}
              {extracting && (
                <p className="extract-more">⏳ 남은 페이지 추출 중… 완료되는 대로 이어집니다.</p>
              )}
              {doc.blocks.length === 0 && !extracting && (
                <p className="empty">표시할 내용이 없습니다.</p>
              )}
            </article>
          </main>
          {panelOpen && <TypographyPanel onClose={() => setPanelOpen(false)} />}
        </div>
        <SelectionTranslate containerSel=".reader-content" />
      </div>
    );
  }

  return (
    <div className="library-root" data-theme="light">
      <h1>Paper Reader</h1>
      <p className="hint">
        추출된 문서가 여기 표시됩니다. 새 논문은 <code>pipeline/extract.py</code> 로 추출하세요.
      </p>
      <button className="link-btn" onClick={refreshDocs}>새로고침</button>
      {loading && <p>여는 중…</p>}
      {docs.length === 0 ? (
        <p className="empty">아직 추출된 문서가 없습니다.</p>
      ) : (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.doc_id}>
              <button onClick={() => open(d.doc_id)}>
                <span className="doc-title">{d.title ?? d.doc_id}</span>
                <span className="doc-meta">
                  {d.state === "extracting"
                    ? `추출 중 ${d.pages_done}/${d.page_count}p`
                    : `${d.page_count}p`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
