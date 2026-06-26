// 앱 루트 — 라이브러리(문서 목록) ↔ 리더 전환. Phase 3: 타이포그래피 실시간 적용.
import { useEffect, useState, type CSSProperties } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";
import { TypographyPanel } from "./typography/TypographyPanel";
import { useStore, registerFonts } from "./store/useStore";
import { toCssVars } from "./store/typography";

export function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<PaperDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const typography = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const initSession = useStore((s) => s.initSession);
  const loadDocState = useStore((s) => s.loadDocState);

  // 앱 시작: 전역 설정 로드 + 라이브러리 목록 + 사용자 폰트 등록
  useEffect(() => {
    initSession();
    refreshDocs();
  }, []);

  // 사용자 폰트가 로드되면 @font-face 등록
  useEffect(() => {
    if (userFonts.length) registerFonts(userFonts);
  }, [userFonts]);

  function refreshDocs() {
    window.paperAPI?.listDocs().then(setDocs).catch(() => setDocs([]));
  }

  async function open(docId: string) {
    setLoading(true);
    try {
      const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
      await loadDocState(docId); // 문서별 타이포 설정 복원(§10)
      setDoc(d);
    } finally {
      setLoading(false);
    }
  }

  if (doc) {
    return (
      <div className="reader-root" data-theme={typography.theme}>
        <header className="reader-bar">
          <button className="back-btn" onClick={() => setDoc(null)}>← 라이브러리</button>
          <span className="reader-title">{doc.title ?? doc.doc_id}</span>
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
            </article>
          </main>
          {panelOpen && <TypographyPanel onClose={() => setPanelOpen(false)} />}
        </div>
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
                <span className="doc-meta">{d.page_count}p</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
