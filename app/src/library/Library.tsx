// 파일탐색기형 라이브러리 — 중첩 폴더 + 다중 선택 + 이동/삭제/이름변경.
// 폴더/배정/이름은 library.json(메타)에만 저장. 문서 파일은 docs:delete 로만 영구 삭제.
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const [moveTarget, setMoveTarget] = useState<Set<string> | null>(null); // 폴더 선택 모달로 이동할 대상 키
  const [menu, setMenu] = useState<{ x: number; y: number; keys: Set<string> } | null>(null); // 우클릭 메뉴
  const [dragOver, setDragOver] = useState<string | null>(null); // 드롭 강조 대상(폴더 id / "home" / "back")
  const dragKeys = useRef<Set<string> | null>(null); // 현재 드래그 중인 항목 키들

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

  const keysToIds = (keys: Set<string>) => ({
    docIds: [...keys].filter((k) => k.startsWith("d:")).map((k) => k.slice(2)),
    folderIds: [...keys].filter((k) => k.startsWith("f:")).map((k) => k.slice(2)),
  });

  // 임의의 키 집합을 dest 폴더(null=홈)로 이동. 폴더는 자기 자신/하위로는 이동 불가.
  const moveKeysTo = (keys: Set<string>, dest: string | null) => {
    const { docIds, folderIds } = keysToIds(keys);
    const folders = lib.folders.map((f) =>
      folderIds.includes(f.id) && f.id !== dest && !isDescendant(dest, f.id) ? { ...f, parentId: dest } : f,
    );
    const docsMeta = { ...lib.docs };
    for (const id of docIds) docsMeta[id] = { ...docsMeta[id], folder: dest };
    persist({ folders, docs: docsMeta });
  };

  // 폴더 선택 모달에서 목적지 선택
  const moveTo = (dest: string | null) => {
    if (moveTarget) moveKeysTo(moveTarget, dest);
    setMoveTarget(null);
    exitSel();
  };

  const deleteKeys = async (keys: Set<string>) => {
    const { docIds, folderIds } = keysToIds(keys);
    if (!docIds.length && !folderIds.length) return;
    if (
      !window.confirm(
        `문서 ${docIds.length}개, 폴더 ${folderIds.length}개를 삭제할까요?\n문서는 영구 삭제됩니다(폴더 내용은 상위로 이동).`,
      )
    )
      return;
    for (const id of docIds) await window.paperAPI.deleteDoc(id);
    let folders = lib.folders;
    const docsMeta = { ...lib.docs };
    for (const fid of folderIds) {
      const parent = folderById(fid)?.parentId ?? null;
      folders = folders.filter((f) => f.id !== fid).map((f) => (f.parentId === fid ? { ...f, parentId: parent } : f));
      for (const k of Object.keys(docsMeta)) if ((docsMeta[k].folder ?? null) === fid) docsMeta[k] = { ...docsMeta[k], folder: parent };
    }
    for (const id of docIds) delete docsMeta[id];
    persist({ folders, docs: docsMeta });
    exitSel();
    onRefresh();
  };

  // ── 우클릭 컨텍스트 메뉴 ────────────────────────────────────────
  // 선택 모드에서 이미 선택된 항목을 우클릭하면 선택 전체가 대상.
  const openMenu = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const keys = selMode && sel.has(key) ? new Set(sel) : new Set([key]);
    setMenu({ x: e.clientX, y: e.clientY, keys });
  };
  const startRename = (keys: Set<string>) => {
    const [only] = [...keys];
    if (only?.startsWith("f:")) {
      const id = only.slice(2);
      setPrompt({ kind: "renameFolder", id, value: folderById(id)?.name ?? "" });
    } else if (only?.startsWith("d:")) {
      const id = only.slice(2);
      const d = docs.find((x) => x.doc_id === id);
      if (d) setPrompt({ kind: "renameDoc", id, value: docTitle(d) });
    }
  };

  // ── 드래그 앤 드롭 이동 ─────────────────────────────────────────
  const onDragStartCard = (e: React.DragEvent, key: string) => {
    const keys = selMode && sel.has(key) ? new Set(sel) : new Set([key]);
    dragKeys.current = keys;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-galpi-move", "1"); // 내부 이동 표식(외부 PDF 드롭과 구분)
  };
  const endDrag = () => {
    dragKeys.current = null;
    setDragOver(null);
  };
  const canDrop = (dest: string | null): boolean => {
    const keys = dragKeys.current;
    if (!keys) return false;
    for (const k of keys) {
      if (!k.startsWith("f:")) continue;
      const fid = k.slice(2);
      if (fid === dest) return false; // 자기 자신
      if (dest && isDescendant(dest, fid)) return false; // 자기 하위
    }
    return true;
  };
  // dest=목적지 폴더(null=홈), mark=강조 식별자
  const dropTarget = (dest: string | null, mark: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragKeys.current) return; // 내부 카드 드래그가 아니면 무시(PDF 등)
      e.preventDefault();
      e.stopPropagation();
      const ok = canDrop(dest);
      e.dataTransfer.dropEffect = ok ? "move" : "none";
      setDragOver(ok ? mark : null);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver((d) => (d === mark ? null : d));
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragKeys.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (canDrop(dest)) moveKeysTo(dragKeys.current, dest);
      endDrag();
      if (selMode) exitSel();
    },
  });

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
          <button className="icon-action" onClick={onRefresh} data-tip="새로고침" aria-label="새로고침">↻</button>
          <button className="icon-action" onClick={onOpenSettings} data-tip="설정" aria-label="설정">{GEAR}</button>
        </div>
      </header>

      {/* 빵부스러기 + 우측 동작 */}
      <div className="lib-toolbar">
        <nav className="lib-crumbs">
          {current && (
            <button
              className={`lib-back ${dragOver === "back" ? "drop-over" : ""}`}
              onClick={() => setCurrent(folderById(current)?.parentId ?? null)}
              title="뒤로"
              aria-label="뒤로"
              {...dropTarget(folderById(current)?.parentId ?? null, "back")}
            >←</button>
          )}
          <button
            className={`lib-crumb ${dragOver === "home" ? "drop-over" : ""}`}
            onClick={() => setCurrent(null)}
            {...dropTarget(null, "home")}
          >홈</button>
          {crumbs.map((f) => (
            <span key={f.id} className="lib-crumb-wrap">
              <span className="lib-crumb-sep">›</span>
              <button
                className={`lib-crumb ${dragOver === f.id ? "drop-over" : ""}`}
                onClick={() => setCurrent(f.id)}
                {...dropTarget(f.id, f.id)}
              >{f.name}</button>
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
            <button className="text-btn" onClick={() => setMoveTarget(new Set(sel))}>이동</button>
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
            <button className="text-btn danger" onClick={() => deleteKeys(new Set(sel))}>삭제</button>
          </div>
        </div>
      )}

      <div className="lib-grid">
        {subfolders.map((f) => {
          const key = "f:" + f.id;
          return (
            <button
              key={f.id}
              className={`folder-card ${selMode && sel.has(key) ? "selected" : ""} ${dragOver === f.id ? "drop-over" : ""}`}
              onClick={() => onCardClick(key, () => setCurrent(f.id))}
              onContextMenu={(e) => openMenu(e, key)}
              draggable
              onDragStart={(e) => onDragStartCard(e, key)}
              onDragEnd={endDrag}
              {...dropTarget(f.id, f.id)}
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
              onContextMenu={(e) => openMenu(e, key)}
              draggable
              onDragStart={(e) => onDragStartCard(e, key)}
              onDragEnd={endDrag}
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
      {moveTarget && (
        <FolderPickerModal
          folders={lib.folders}
          disabledIds={[...moveTarget].filter((k) => k.startsWith("f:")).map((k) => k.slice(2))}
          onPick={moveTo}
          onCancel={() => setMoveTarget(null)}
        />
      )}

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            <button className="ctx-item" onClick={() => { setMoveTarget(menu.keys); setMenu(null); }}>이동…</button>
            {menu.keys.size === 1 && (
              <button className="ctx-item" onClick={() => { startRename(menu.keys); setMenu(null); }}>이름 변경</button>
            )}
            <div className="ctx-sep" />
            <button className="ctx-item danger" onClick={() => { const k = menu.keys; setMenu(null); void deleteKeys(k); }}>삭제</button>
          </div>
        </>
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
