// 앱 루트 — 라이브러리(문서 목록) ↔ 리더 전환. Phase 2 기본 리플로우 렌더까지.
import { useEffect, useState } from "react";
import type { PaperDocument } from "./types";
import type { DocSummary } from "../electron/preload";
import { BlockRenderer } from "./render/BlockRenderer";

export function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [doc, setDoc] = useState<PaperDocument | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    window.paperAPI?.listDocs().then(setDocs).catch(() => setDocs([]));
  }, []);

  async function open(docId: string) {
    setLoading(true);
    try {
      const d = (await window.paperAPI.loadDoc(docId)) as PaperDocument;
      setDoc(d);
    } finally {
      setLoading(false);
    }
  }

  if (doc) {
    return (
      <div className="reader-root" data-theme="light">
        <header className="reader-bar">
          <button className="back-btn" onClick={() => setDoc(null)}>← 라이브러리</button>
          <span className="reader-title">{doc.title ?? doc.doc_id}</span>
        </header>
        <main className="reader-scroll">
          <article className="reader-content">
            {doc.blocks.map((b) => (
              <BlockRenderer key={b.id} block={b} docId={doc.doc_id} />
            ))}
          </article>
        </main>
      </div>
    );
  }

  return (
    <div className="library-root" data-theme="light">
      <h1>Paper Reader</h1>
      <p className="hint">
        추출된 문서가 여기 표시됩니다. 새 논문은 <code>pipeline/extract.py</code> 로 추출하세요.
      </p>
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
