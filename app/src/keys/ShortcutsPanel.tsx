// 단축키 설정 창 — 액션별 키 바인딩을 보고 재설정한다(전역 settings 에 영속).
// "변경"을 누르면 다음 키 입력을 캡처해 바인딩에 저장. Esc 로 취소.
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { ACTIONS, displayCombo, eventToCombo, type ActionId } from "./keymap";

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const keymap = useStore((s) => s.keymap);
  const setKeybinding = useStore((s) => s.setKeybinding);
  const resetKeymap = useStore((s) => s.resetKeymap);
  const [recording, setRecording] = useState<ActionId | null>(null);

  // 녹화 중: 다음 유효 조합을 캡처. 모달 Esc 닫힘보다 우선하도록 capture 단계.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // 수식 키 단독 — 계속 대기
      setKeybinding(recording, combo);
      setRecording(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [recording, setKeybinding]);

  // 모달 자체 Esc 닫기 (녹화 중이 아닐 때만)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !recording) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, recording]);

  // 중복 바인딩 표시용
  const counts = ACTIONS.reduce<Record<string, number>>((m, a) => {
    const c = keymap[a.id];
    m[c] = (m[c] ?? 0) + 1;
    return m;
  }, {});

  return (
    <div className="modal-backdrop" style={{ zIndex: 130 }} onMouseDown={() => !recording && onClose()}>
      <aside className="typo-panel modal keys-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="typo-head">
          <strong>단축키 설정</strong>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">×</button>
        </div>

        <ul className="keys-list">
          {ACTIONS.map((a) => {
            const combo = keymap[a.id];
            const dup = counts[combo] > 1;
            return (
              <li key={a.id} className="keys-row">
                <div className="keys-info">
                  <span className="keys-label">{a.label}</span>
                  <span className="keys-hint">{a.hint}</span>
                </div>
                <button
                  className={`keys-bind ${recording === a.id ? "recording" : ""} ${dup ? "dup" : ""}`}
                  onClick={() => setRecording(a.id)}
                  title={dup ? "다른 액션과 겹칩니다" : "클릭 후 새 키 입력"}
                >
                  {recording === a.id ? "키 입력…" : displayCombo(combo)}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="typo-note">
          형광펜은 선택 후 단축키를 <b>탭하면 색 순환</b>, <b>꾹 누르면 제거</b>됩니다. · 고정 단축키:
          <b>←/→</b>(한 화면씩 이동) · ↑/↓(미세 스크롤) · ⌥+클릭(원본 검사) · ⌥⇧D(디버그) · Esc(닫기).
        </p>

        <div className="typo-section typo-actions">
          <button className="link-btn" onClick={resetKeymap}>기본 단축키로 되돌리기</button>
          <span className="typo-note">변경은 자동 저장됩니다.</span>
        </div>
      </aside>
    </div>
  );
}
