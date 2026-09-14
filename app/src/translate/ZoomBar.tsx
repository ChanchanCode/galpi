// 배율 컨트롤 — 보기 A·B 공용. 숫자를 누르면 100% 로 돌아온다.
export function ZoomBar({
  z,
  onZoom,
  onReset,
}: {
  z: number;
  onZoom: (f: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="src-zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button onClick={() => onZoom(1 / 1.25)} aria-label="축소">−</button>
      <button className="src-zoom-n" onClick={onReset} data-tip="원래 크기 · ⌘0">
        {Math.round(z * 100)}%
      </button>
      <button onClick={() => onZoom(1.25)} aria-label="확대">＋</button>
    </div>
  );
}
