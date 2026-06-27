// 파일탐색기형 라이브러리 — 중첩 폴더 + 다중 선택 + 이동/삭제/이름변경.
// 폴더/배정/이름은 library.json(메타)에만 저장. 문서 파일은 docs:delete 로만 영구 삭제.
import { useEffect, useState, type ReactNode } from "react";
import type { DocSummary } from "../../electron/preload";
import { GalpiMark } from "../ui/GalpiMark";

const GEAR = "⚙";

interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}
interface LibMeta {
  folders: Folder[];
  docs: Record<string, { folder?: string | null; title?: string }>;
}

function newId(): string {
  return "f_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

interface Props {
  docs: DocSummary[];
  onOpen: (docId: string) => void;
  onToggleFinished: (d: DocSummary) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  dropProps: Record<string, unknown>;
}

export function Library({ docs, onOpen, onToggleFinished, onRefresh, onOpenSettings, dropProps }: Props) {
  const [lib, setLib] = useState<LibMeta>({ folders: [], docs: {} });
  const [current, setCurrent] = useState<string | null>(null);
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<{ kind: "newFolder" | "renameFolder" | "renameDoc"; id?: string; value: string } | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    window.paperAPI.loadLibrary().then(setLib);
  }, []);

  const persist = (next: LibMeta) => {
    setLib(next);
    void window.paperAPI.saveLibrary(next);
  };

  const docFolder = (id: string) => lib.docs[id]?.folder ?? null;
  const docTitle = (d: DocSummary) => lib.docs[d.doc_id]?.title ?? d.title ?? d.doc_id;
  const folderById = (id: string | null) => lib.folders.find((f) => f.id === id) ?? null;

  const subfolders = lib.folders.filter((f) => f.parentId === current).sort((a, b) => a.name.localeCompare(b.name));
  const folderDocs = docs.filter((d) => docFolder(d.doc_id) === current);
  const folderCount = (fid: string) =>
    docs.filter((d) => docFolder(d.doc_id) === fid).length + lib.folders.filter((f) => f.parentId === fid).length;

  // 빵부스러기 경로
  const crumbs: Folder[] = [];
  for (let c = current; c; ) {
    const f = folderById(c);
    if (!f) break;
    crumbs.unshift(f);
    c = f.parentId;
  }

  const isDescendant = (folderId: string | null, maybeAncestor: string): boolean => {
    for (let p = folderId; p; ) {
      if (p === maybeAncestor) return true;
      p = folderById(p)?.parentId ?? null;
    }
    return false;
  };

  // ── 선택 ────────────────────────────────────────────────────────
  const toggleSel = (key: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const exitSel = () => {
    setSelMode(false);
    setSel(new Set());
  };
  const selDocIds = [...sel].filter((k) => k.startsWith("d:")).map((k) => k.slice(2));
  const selFolderIds = [...sel].filter((k) => k.startsWith("f:")).map((k) => k.slice(2));

  // ── 액션 ────────────────────────────────────────────────────────
  const createFolder = (name: string) =>
    persist({ ...lib, folders: [...lib.folders, { id: newId(), name: name.trim() || "새 폴더", parentId: current }] });
  const renameFolder = (id: string, name: string) =>
    persist({ ...lib, folders: lib.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)) });
  const renameDoc = (id: string, name: string) =>
    persist({ ...lib, docs: { ...lib.docs, [id]: { ...lib.docs[id], title: name.trim() || undefined } } });

  const moveTo = (dest: string | null) => {
    const folders = lib.folders.map((f) =>
      selFolderIds.includes(f.id) && !isDescendant(dest, f.id) ? { ...f, parentId: dest } : f,
    );
    const docsMeta = { ...lib.docs };
    for (const id of selDocIds) docsMeta[id] = { ...docsMeta[id], folder: dest };
    persist({ folders, docs: docsMeta });
    setMoving(false);
    exitSel();
  };

  const deleteSelected = async () => {
    if (
      !window.confirm(
        `문서 ${selDocIds.length}개, 폴더 ${selFolderIds.length}개를 삭제할까요?\n문서는 영구 삭제됩니다(폴더 내용은 상위로 이동).`,
      )
    )
      return;
    for (const id of selDocIds) await window.paperAPI.deleteDoc(id);
    let folders = lib.folders;
    const docsMeta = { ...lib.docs };
    for (const fid of selFolderIds) {
      const parent = folderById(fid)?.parentId ?? null;
      folders = folders.filter((f) => f.id !== fid).map((f) => (f.parentId === fid ? { ...f, parentId: parent } : f));
      for (const k of Object.keys(docsMeta)) if ((docsMeta[k].folder ?? null) === fid) docsMeta[k] = { ...docsMeta[k], folder: parent };
    }
    for (const id of selDocIds) delete docsMeta[id];
    persist({ folders, docs: docsMeta });
    exitSel();
    onRefresh();
  };

  const submitPrompt = (value: string) => {
    if (!prompt) return;
    if (prompt.kind === "newFolder") createFolder(value);
    else if (prompt.kind === "renameFolder" && prompt.id) renameFolder(prompt.id, value);
    else if (prompt.kind === "renameDoc" && prompt.id) renameDoc(prompt.id, value);
    setPrompt(null);
    if (prompt.kind !== "newFolder") exitSel();
  };

  const onCardClick = (key: string, action: () => void) => {
    if (selMode) toggleSel(key);
    else action();
  };

  const empty = subfolders.length === 0 && folderDocs.length === 0;

  return (
    <div className="library-root" {...dropProps}>
      <header className="library-bar">
        <div className="library-brand">
          <GalpiMark size={34} />
          <h1>갈피</h1>
        </div>
        <div className="bar-actions">
          <button className="icon-action" onClick={onRefresh} title="새로고침" aria-label="새로고침">↻</button>
          <button className="icon-action" onClick={onOpenSettings} title="설정" aria-label="설정">{GEAR}</button>
        </div>
      </header>

      {/* 빵부스러기 + 우측 동작 */}
      <div className="lib-toolbar">
        <nav className="lib-crumbs">
          <button className="lib-crumb" onClick={() => setCurrent(null)}>홈</button>
          {crumbs.map((f) => (
            <span key={f.id} className="lib-crumb-wrap">
              <span className="lib-crumb-sep">›</span>
              <button className="lib-crumb" onClick={() => setCurrent(f.id)}>{f.name}</button>
            </span>
          ))}
        </nav>
        <div className="lib-actions">
          {selMode ? (
            <button className="text-btn" onClick={exitSel}>완료</button>
          ) : (
            <>
              <button className="text-btn" onClick={() => setPrompt({ kind: "newFolder", value: "" })}>+ 새 폴더</button>
              <button className="text-btn" onClick={() => setSelMode(true)}>선택</button>
            </>
          )}
        </div>
      </div>

      {/* 선택 동작 바 */}
      {selMode && sel.size > 0 && (
        <div className="lib-selbar">
          <span className="lib-selcount">{sel.size}개 선택</span>
          <div className="lib-selacts">
            <button className="text-btn" onClick={() => setMoving(true)}>이동</button>
            {sel.size === 1 && (
              <button
                className="text-btn"
                onClick={() => {
                  if (selFolderIds[0]) setPrompt({ kind: "renameFolder", id: selFolderIds[0], value: folderById(selFolderIds[0])?.name ?? "" });
                  else if (selDocIds[0]) setPrompt({ kind: "renameDoc", id: selDocIds[0], value: docTitle(docs.find((d) => d.doc_id === selDocIds[0])!) });
                }}
              >
                이름 변경
              </button>
            )}
            <button className="text-btn danger" onClick={deleteSelected}>삭제</button>
          </div>
        </div>
      )}

      <div className="lib-grid">
        {subfolders.map((f) => {
          const key = "f:" + f.id;
          return (
            <button
              key={f.id}
              className={`folder-card ${selMode && sel.has(key) ? "selected" : ""}`}
              onClick={() => onCardClick(key, () => setCurrent(f.id))}
            >
              {selMode && <span className={`sel-check ${sel.has(key) ? "on" : ""}`} />}
              <span className="folder-icon">📁</span>
              <span className="folder-name">{f.name}</span>
              <span className="folder-count">{folderCount(f.id)}</span>
            </button>
          );
        })}

        {folderDocs.map((d) => {
          const key = "d:" + d.doc_id;
          const sub = [d.authors, d.journal].filter(Boolean).join(" · ");
          const read = relTime(d.last_read_at);
          return (
            <div
              key={d.doc_id}
              className={`doc-card ${d.finished ? "is-finished" : ""} ${selMode && sel.has(key) ? "selected" : ""}`}
              onClick={() => onCardClick(key, () => onOpen(d.doc_id))}
            >
              {selMode && <span className={`sel-check ${sel.has(key) ? "on" : ""}`} />}
              <div className="doc-main">
                <span className="doc-title">{docTitle(d)}</span>
                {sub && <span className="doc-sub">{sub}</span>}
                <span className="doc-foot">
                  {d.state === "extracting" ? `추출 중 ${d.pages_done}/${d.page_count}p` : `${d.page_count}p`}
                  {read && <span className="doc-dot">·</span>}
                  {read && <span>{read} 읽음</span>}
                </span>
              </div>
              {!selMode && (
                <button
                  className={`finish-toggle ${d.finished ? "on" : ""}`}
                  onClick={(e) => { e.stopPropagation(); onToggleFinished(d); }}
                  title={d.finished ? "완독 해제" : "완독으로 표시"}
                >
                  {d.finished ? "✓ 완독" : "완독"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {empty && (
        <p className="empty">
          {lib.folders.length || docs.length ? "이 폴더는 비어 있습니다." : "PDF를 끌어다 놓으면 추출이 시작됩니다."}
        </p>
      )}

      {prompt && (
        <TextPromptModal
          title={prompt.kind === "newFolder" ? "새 폴더" : "이름 변경"}
          initial={prompt.value}
          onSubmit={submitPrompt}
          onCancel={() => setPrompt(null)}
        />
      )}
      {moving && (
        <FolderPickerModal
          folders={lib.folders}
          disabledIds={selFolderIds}
          onPick={moveTo}
          onCancel={() => setMoving(false)}
        />
      )}
    </div>
  );
}

// ── 이름 입력 모달 ────────────────────────────────────────────────
function TextPromptModal({ title, initial, onSubmit, onCancel }: { title: string; initial: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="mini-modal" onMouseDown={(e) => e.stopPropagation()}>
        <strong>{title}</strong>
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSubmit(v); if (e.key === "Escape") onCancel(); }}
        />
        <div className="mini-actions">
          <button className="text-btn" onClick={onCancel}>취소</button>
          <button className="text-btn primary" onClick={() => onSubmit(v)}>확인</button>
        </div>
      </div>
    </div>
  );
}

// ── 폴더 선택(이동 대상) 모달 — 트리 ──────────────────────────────
function FolderPickerModal({ folders, disabledIds, onPick, onCancel }: { folders: Folder[]; disabledIds: string[]; onPick: (dest: string | null) => void; onCancel: () => void }) {
  const isDisabled = (id: string): boolean => {
    // 선택된 폴더 자신/그 하위로는 이동 불가
    for (const sel of disabledIds) {
      for (let p: string | null = id; p; ) {
        if (p === sel) return true;
        p = folders.find((f) => f.id === p)?.parentId ?? null;
      }
    }
    return false;
  };
  const renderLevel = (parentId: string | null, depth: number): ReactNode =>
    folders
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => (
        <div key={f.id}>
          <button
            className="picker-row"
            style={{ paddingLeft: 12 + depth * 18 }}
            disabled={isDisabled(f.id)}
            onClick={() => onPick(f.id)}
          >
            📁 {f.name}
          </button>
          {renderLevel(f.id, depth + 1)}
        </div>
      ));
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="mini-modal picker" onMouseDown={(e) => e.stopPropagation()}>
        <strong>이동할 폴더</strong>
        <div className="picker-list">
          <button className="picker-row" onClick={() => onPick(null)}>🏠 홈</button>
          {renderLevel(null, 0)}
        </div>
        <div className="mini-actions">
          <button className="text-btn" onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>
  );
}
