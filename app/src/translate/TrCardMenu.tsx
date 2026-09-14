// 번역 카드 우클릭(또는 ⌘/Ctrl+클릭) 메뉴 — 다시 번역.
// 보기 A·B 어느 쪽 카드든 같은 메뉴가 뜨도록 문서 수준에서 한 번만 듣는다.
import { useEffect, useState } from "react";

interface Menu {
  x: number;
  y: number;
  id: string;
}

export function TrCardMenu({
  onRedoBlock,
  onRedoAll,
}: {
  onRedoBlock: (blockId: string) => void;
  onRedoAll: () => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    const open = (e: MouseEvent) => {
      const card = (e.target as HTMLElement)?.closest?.(".tr-card") as HTMLElement | null;
      const id = card?.dataset.trFor;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      setConfirmAll(false);
      setMenu({ x: e.clientX, y: e.clientY, id });
    };
    const onCtx = (e: MouseEvent) => open(e);
    // ⌘/Ctrl+클릭도 같은 메뉴 — 트랙패드에서 우클릭이 번거로운 경우가 있다.
    const onClick = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) open(e);
    };
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  if (!menu) return null;
  const left = Math.min(menu.x, window.innerWidth - 190);
  const top = Math.min(menu.y, window.innerHeight - 110);

  return (
    <div className="tr-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => {
          onRedoBlock(menu.id);
          setMenu(null);
        }}
      >
        재번역
      </button>
      {confirmAll ? (
        <button
          className="danger"
          onClick={() => {
            onRedoAll();
            setMenu(null);
          }}
        >
          전체 재번역 · 확인
        </button>
      ) : (
        <button onClick={() => setConfirmAll(true)}>전체 재번역</button>
      )}
    </div>
  );
}
