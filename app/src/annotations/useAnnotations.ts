// 주석(형광펜 + 메모)을 한 곳에서 소유하는 훅 — state.json 사이드카가 단일 진실 원천.
// HighlightLayer / NotesLayer(생성·표시) 와 AnnotationsPanel(모아보기·편집) 이 모두 이 훅의
// 상태를 공유하므로, 어디서 바꿔도 즉시 일관되게 반영되고 한 번에 병합 저장된다(§10).
import { useCallback, useEffect, useRef, useState } from "react";
import type { HighlightRule } from "../highlight/highlights";
import type { Note } from "../notes/notes";

export interface AnnotationsApi {
  highlights: HighlightRule[];
  notes: Note[];
  loaded: boolean;
  updateHighlights: (updater: (prev: HighlightRule[]) => HighlightRule[]) => void;
  updateNotes: (updater: (prev: Note[]) => Note[]) => void;
}

export function useAnnotations(docId: string | null): AnnotationsApi {
  const [highlights, setHighlights] = useState<HighlightRule[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const hlRef = useRef<HighlightRule[]>([]);
  const noteRef = useRef<Note[]>([]);
  const loadedFor = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 문서 전환 시 로드 (없으면 빈 상태)
  useEffect(() => {
    loadedFor.current = null;
    setLoaded(false);
    setHighlights([]);
    setNotes([]);
    hlRef.current = [];
    noteRef.current = [];
    if (!docId) return;
    let alive = true;
    (async () => {
      const st = (await window.paperAPI.loadState(docId)) as
        | { highlights?: HighlightRule[]; notes?: Note[] }
        | null;
      if (!alive) return;
      const h = Array.isArray(st?.highlights) ? st!.highlights! : [];
      const n = Array.isArray(st?.notes) ? st!.notes! : [];
      hlRef.current = h;
      noteRef.current = n;
      setHighlights(h);
      setNotes(n);
      loadedFor.current = docId;
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  // 형광펜·메모를 한 번에 병합 저장(다른 state 키 보존). 디바운스 300ms.
  const schedulePersist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = docId;
    saveTimer.current = setTimeout(() => {
      if (id && loadedFor.current === id) {
        void window.paperAPI.updateReading(id, {
          highlights: hlRef.current,
          notes: noteRef.current,
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

  return { highlights, notes, loaded, updateHighlights, updateNotes };
}
