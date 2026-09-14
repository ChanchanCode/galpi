// 문서 번역 상태의 단일 소유자 — 보기 A(TranslateColumn)·보기 B(SourceView)·바(TranslateBar)가 공유.
// main 의 translate:block / translate:progress 푸시를 받아 blockId → 번역 으로 모은다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranslatePlan, TranslateProgress, TrCacheEntry, TrSpan } from "../../electron/preload";
import type { TrSource } from "./trBlocks";
import { viewportFirst } from "./trBlocks";

export type TrView = "reflow" | "source";

export interface TrEntry {
  ko: string;
  spans?: TrSpan[];
  coverage?: number;
}

export interface TranslationApi {
  on: boolean;
  view: TrView;
  entries: Map<string, TrEntry>;
  progress: TranslateProgress | null;
  plan: TranslatePlan | null;
  running: boolean;
  /** 지금 다시 번역 중인 블록 id — 카드에 표식을 준다. */
  redoing: Set<string>;
  width: number;
  setOn: (v: boolean) => void;
  retranslate: (blockId: string) => void;
  toggle: () => void;
  toggleView: () => void;
  start: (force?: boolean) => void;
  cancel: () => void;
  setWidth: (n: number) => void;
  refreshPlan: () => void;
}

export const TR_WIDTH_MIN = 220;
export const TR_WIDTH_MAX = 720;
export const TR_WIDTH_DEFAULT = 380;

export function useTranslation(docId: string | null, docTitle: string, blocks: TrSource[]): TranslationApi {
  const [on, setOn] = useState(false);
  const [view, setView] = useState<TrView>("reflow");
  const [entries, setEntries] = useState<Map<string, TrEntry>>(new Map());
  const [progress, setProgress] = useState<TranslateProgress | null>(null);
  const [plan, setPlan] = useState<TranslatePlan | null>(null);
  const [running, setRunning] = useState(false);
  const [redoing, setRedoing] = useState<Set<string>>(new Set());
  const [width, setWidthState] = useState(TR_WIDTH_DEFAULT);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const widthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 문서가 바뀌면 전부 리셋. 번역 표시는 문서에 묶인다.
  useEffect(() => {
    setEntries(new Map());
    setProgress(null);
    setPlan(null);
    setRunning(false);
    setRedoing(new Set());
    setOn(false);
    setView("reflow");
    setWidthState(TR_WIDTH_DEFAULT);
    if (!docId) return;
    let alive = true;
    void (async () => {
      const st = (await window.paperAPI.loadState(docId)) as { tr_width?: number } | null;
      if (alive && typeof st?.tr_width === "number") setWidthState(clampWidth(st.tr_width));
      const busy = await window.paperAPI.isTranslating(docId);
      if (alive && busy) setRunning(true);
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  // main 푸시 구독. 문서 전환 중 남은 이벤트를 먹지 않게 docId 로 거른다.
  useEffect(() => {
    const offBlock = window.paperAPI.onTranslateBlock((b) => {
      if (b.docId !== docId) return;
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(b.id, { ko: b.ko, spans: b.spans, coverage: b.coverage });
        return next;
      });
    });
    const offProg = window.paperAPI.onTranslateProgress((p) => {
      if (p.docId !== docId) return;
      setProgress(p);
      setRunning(p.state === "running");
    });
    return () => {
      offBlock();
      offProg();
    };
  }, [docId]);

  const refreshPlan = useCallback(() => {
    if (!docId || !blocksRef.current.length) return;
    void window.paperAPI
      .translatePlan({ docId, docTitle, blocks: blocksRef.current })
      .then(setPlan)
      .catch(() => setPlan(null));
  }, [docId, docTitle]);

  // 캐시분은 **문서를 열 때 미리** 받아 둔다 — T 를 누른 뒤에 IPC·텍스트 해시를 기다리면
  // 카드가 한 박자 늦게 뜬다(사용자 신고). 유휴 시간에 돌려 문서 여는 속도는 건드리지 않는다.
  useEffect(() => {
    if (!docId || !blocks.length) return;
    let alive = true;
    const run = async () => {
      const cached = (await window.paperAPI.cachedTranslations(
        docId,
        blocks.map((b) => ({ id: b.id, text: b.text })),
      )) as Record<string, TrCacheEntry>;
      if (!alive) return;
      setEntries((prev) => {
        let next: Map<string, TrEntry> | null = null;
        for (const [id, e] of Object.entries(cached)) {
          if (prev.has(id)) continue;
          next ??= new Map(prev);
          next.set(id, { ko: e.ko, spans: e.spans, coverage: e.coverage });
        }
        return next ?? prev;
      });
    };
    const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const h = idle ? idle(() => void run().catch(() => {}), { timeout: 1200 }) : window.setTimeout(() => void run().catch(() => {}), 200);
    return () => {
      alive = false;
      const cancel = (window as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(h);
      else clearTimeout(h);
    };
  }, [docId, blocks]);

  // 켜는 순간엔 견적만 낸다(모델 호출 없음).
  useEffect(() => {
    if (!on || !docId || !blocks.length) return;
    refreshPlan();
  }, [on, docId, blocks, refreshPlan]);

  const start = useCallback(
    (force?: boolean) => {
      if (!docId || !blocksRef.current.length) return;
      const content = document.querySelector(".reader-content") as HTMLElement | null;
      setRunning(true);
      if (force) setEntries(new Map());
      void window.paperAPI
        .translateDoc({
          docId,
          docTitle,
          blocks: viewportFirst(blocksRef.current, content),
          force,
        })
        .then((p) => {
          setProgress(p);
          setRunning(false);
          refreshPlan();
        })
        .catch(() => setRunning(false));
    },
    [docId, docTitle, refreshPlan],
  );

  const cancel = useCallback(() => {
    if (!docId) return;
    void window.paperAPI.cancelDocTranslation(docId);
  }, [docId]);

  const setWidth = useCallback(
    (n: number) => {
      const w = clampWidth(n);
      setWidthState(w);
      if (!docId) return;
      if (widthTimer.current) clearTimeout(widthTimer.current);
      widthTimer.current = setTimeout(() => {
        void window.paperAPI.updateReading(docId, { tr_width: w });
      }, 400);
    },
    [docId],
  );

  const toggle = useCallback(() => setOn((v) => !v), []);
  // 보기 전환은 번역과 **독립**이다 — 번역 없이 원문 지면만 보고 싶을 때가 있다.
  const toggleView = useCallback(() => {
    setView((v) => (v === "reflow" ? "source" : "reflow"));
  }, []);

  // 블록 하나만 다시 번역(캐시 우회). 나머지 카드는 그대로 둔다.
  const retranslate = useCallback(
    (blockId: string) => {
      if (!docId) return;
      const b = blocksRef.current.find((x) => x.id === blockId);
      if (!b) return;
      setRedoing((prev) => new Set(prev).add(blockId));
      void window.paperAPI
        .translateDoc({ docId, docTitle, blocks: [b], force: true })
        .catch(() => {})
        .finally(() => {
          setRedoing((prev) => {
            const n = new Set(prev);
            n.delete(blockId);
            return n;
          });
          refreshPlan();
        });
    },
    [docId, docTitle, refreshPlan],
  );

  return useMemo(
    () => ({
      on,
      view,
      entries,
      progress,
      plan,
      running,
      redoing,
      width,
      setOn,
      toggle,
      toggleView,
      start,
      cancel,
      setWidth,
      refreshPlan,
      retranslate,
    }),
    [on, view, entries, progress, plan, running, redoing, width, toggle, toggleView, start, cancel, setWidth, refreshPlan, retranslate],
  );
}

function clampWidth(n: number): number {
  return Math.max(TR_WIDTH_MIN, Math.min(TR_WIDTH_MAX, Math.round(n)));
}
