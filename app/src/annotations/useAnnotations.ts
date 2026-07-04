// 주석(형광펜 + 메모)을 한 곳에서 소유하는 훅 — state.json 사이드카가 단일 진실 원천.
// HighlightLayer / NotesLayer(생성·표시) 와 AnnotationsPanel(모아보기·편집) 이 모두 이 훅의
// 상태를 공유하므로, 어디서 바꿔도 즉시 일관되게 반영되고 한 번에 병합 저장된다(§10).
import { useCallback, useEffect, useRef, useState } from "react";
import type { HighlightRule } from "../highlight/highlights";
import type { Note } from "../notes/notes";

export interface AnnotationsApi {
  highlights: HighlightRule[];
  notes: Note[];
  /** 수식 LaTeX 수동 수정 (§11-10) — blockId → 고친 LaTeX. 재추출해도 보존. */
  formulaEdits: Record<string, string>;
  loaded: boolean;
  updateHighlights: (updater: (prev: HighlightRule[]) => HighlightRule[]) => void;
  updateNotes: (updater: (prev: Note[]) => Note[]) => void;
  setFormulaEdit: (blockId: string, latex: string | null) => void;
}

export function useAnnotations(docId: string | null): AnnotationsApi {
  const [highlights, setHighlights] = useState<HighlightRule[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [formulaEdits, setFormulaEdits] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const hlRef = useRef<HighlightRule[]>([]);
  const noteRef = useRef<Note[]>([]);
  const feRef = useRef<Record<string, string>>({});
  const loadedFor = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 디바운스 중인 저장을 즉시 커밋 — 문서 전환/언마운트 직전에 호출해 마지막 주석 유실 방지.
  const flushPersist = useCallback(() => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const id = loadedFor.current;
    if (id) {
      void window.paperAPI.updateReading(id, {
        highlights: hlRef.current,
        notes: noteRef.current,
        formula_edits: feRef.current,
      });
    }
  }, []);

  // 문서 전환 시 로드 (없으면 빈 상태)
  useEffect(() => {
    flushPersist(); // 이전 문서의 미저장 주석 먼저 커밋(refs 리셋 전)
    loadedFor.current = null;
    setLoaded(false);
    setHighlights([]);
    setNotes([]);
    setFormulaEdits({});
    hlRef.current = [];
    noteRef.current = [];
    feRef.current = {};
    if (!docId) return;
    let alive = true;
    (async () => {
      const st = (await window.paperAPI.loadState(docId)) as
        | { highlights?: HighlightRule[]; notes?: Note[]; formula_edits?: Record<string, string> }
        | null;
      if (!alive) return;
      const h = Array.isArray(st?.highlights) ? st!.highlights! : [];
      const n = Array.isArray(st?.notes) ? st!.notes! : [];
      const fe = st?.formula_edits && typeof st.formula_edits === "object" ? st.formula_edits : {};
      hlRef.current = h;
      noteRef.current = n;
      feRef.current = fe;
      setHighlights(h);
      setNotes(n);
      setFormulaEdits(fe);
      loadedFor.current = docId;
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [docId, flushPersist]);

  // 언마운트(앱 종료 등) 시에도 미저장 주석 커밋
  useEffect(() => () => flushPersist(), [flushPersist]);

  // 형광펜·메모를 한 번에 병합 저장(다른 state 키 보존). 디바운스 300ms.
  const schedulePersist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = docId;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (id && loadedFor.current === id) {
        void window.paperAPI.updateReading(id, {
          highlights: hlRef.current,
          notes: noteRef.current,
          formula_edits: feRef.current,
        });
      }
    }, 300);
  }, [docId]);

  const updateHighlights = useCallback(
    (updater: (prev: HighlightRule[]) => HighlightRule[]) => {
      setHighlights((prev) => {
        const next = updater(prev);
        hlRef.current = next;
        schedulePersist();
        return next;
      });
    },
    [schedulePersist],
  );

  const updateNotes = useCallback(
    (updater: (prev: Note[]) => Note[]) => {
      setNotes((prev) => {
        const next = updater(prev);
        noteRef.current = next;
        schedulePersist();
        return next;
      });
    },
    [schedulePersist],
  );

  const setFormulaEdit = useCallback(
    (blockId: string, latex: string | null) => {
      setFormulaEdits((prev) => {
        const next = { ...prev };
        if (latex == null) delete next[blockId];
        else next[blockId] = latex;
        feRef.current = next;
        schedulePersist();
        return next;
      });
    },
    [schedulePersist],
  );

  return { highlights, notes, formulaEdits, loaded, updateHighlights, updateNotes, setFormulaEdit };
}
