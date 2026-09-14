// 키워드 형광펜 (명세 §8) — 단축키 중심. (2026-06 사용자 요청으로 선택 미니 툴바를 뺐다가, 2026-09 채팅 기능과 함께
// 사용자가 선택 툴바를 다시 요청 → src/selection/SelectionToolbar 가 "galpi:action" 으로 **키 탭과 같은 경로**를 부른다.)
// 본문에서 텍스트 선택 후:
//   · 단축키 탭 → 색 순환(노랑→초록→파랑→분홍→보라→해제)
//   · 단축키 꾹 누름 → 즉시 제거
// 같은 텍스트가 문서 전체에서 함께 칠해진다.
// 상태(규칙)는 useAnnotations 훅이 소유하고 props 로 내려준다(제어형). 본 레이어는
// "본문 적용 + 키보드 생성/순환/제거 + 출현 수 집계"만 담당하고, 목록 UI 는 AnnotationsPanel 이 그린다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import { useStore } from "../store/useStore";
import { baseKey, isEditableTarget, matchCombo } from "../keys/keymap";
import { onAction } from "../selection/quote";
import {
  applyHighlights,
  clearHighlights,
  normalizeText,
  occurrenceOf,
  ruleScope,
  type HighlightRule,
  type HlColor,
  type HlScope,
} from "./highlights";

const CONTAINER_SEL = ".reader-content";
const HOLD_MS = 450; // 이 시간 이상 누르면 "제거"
const CYCLE: HlColor[] = ["yellow", "green", "blue", "pink", "purple"];
const COLOR_LABEL: Record<HlColor, string> = {
  yellow: "노랑",
  green: "초록",
  blue: "파랑",
  pink: "분홍",
  purple: "보라",
};

interface Props {
  doc: PaperDocument;
  rules: HighlightRule[];
  updateRules: (updater: (prev: HighlightRule[]) => HighlightRule[]) => void;
  onCounts: (counts: Record<string, number>) => void;
}

function newId(): string {
  return "h_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export function HighlightLayer({ doc, rules, updateRules, onCounts }: Props) {
  const keymap = useStore((s) => s.keymap);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 누름 추적: keydown 시작 시각으로 홀드(키 반복) 판별. 탭은 keydown 에서 바로 처리.
  const press = useRef<{
    key: string;
    scope: HlScope;
    text: string;
    occurrence: number;
    startedAt: number;
    removed: boolean;
  } | null>(null);

  // 문서 닫힐 때 우리 하이라이트 정리
  useEffect(() => () => clearHighlights(), [doc.doc_id]);

  // 규칙/문서 변경 → 하이라이트 재계산 (DOM 렌더 후 rAF). 출현 수는 위로 보고.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
      if (container) onCounts(applyHighlights(container, rules));
    });
    return () => cancelAnimationFrame(raf);
  }, [rules, doc, onCounts]);

  const flashStatus = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 1400);
  }, []);

  // 선택 배경 살짝 숨김 — ::selection 파란 배경이 형광펜 색 위에 그려져 색을 가리므로,
  // 형광펜을 적용한 직후에만 투명하게(선택 자체는 유지). 다음 드래그/클릭 때 복원.
  const dimmedFor = useRef<string | null>(null);
  const setDim = useCallback((text: string | null) => {
    if (text) {
      document.body.dataset.hlDim = "on";
      dimmedFor.current = text;
    } else {
      delete document.body.dataset.hlDim;
      dimmedFor.current = null;
    }
  }, []);

  // 새 선택을 시작하거나(드래그/클릭) 선택이 바뀌면 dim 해제 → 일반 선택 표시 복원.
  useEffect(() => {
    const onSelChange = () => {
      if (!dimmedFor.current) return;
      const t = normalizeText(window.getSelection()?.toString() ?? "");
      if (t !== dimmedFor.current) setDim(null);
    };
    const onDown = () => {
      if (dimmedFor.current) setDim(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("mousedown", onDown);
      setDim(null);
    };
  }, [setDim]);

  // 현재 선택(본문 컨테이너 안) → 정규화 텍스트 + Range. passage 는 Range 로 출현 위치를 잡는다.
  const readSelection = useCallback((): { text: string; range: Range } | null => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const text = normalizeText(s.toString());
    if (text.length < 2) return null;
    const range = s.getRangeAt(0);
    const container = document.querySelector(CONTAINER_SEL);
    if (!container || !container.contains(range.commonAncestorContainer)) return null;
    return { text, range };
  }, []);

  // 같은 대상 규칙 찾기 — 중복 생성 방지. keyword: 같은 텍스트. passage: 같은 텍스트+같은 출현.
  const findRule = useCallback(
    (prev: HighlightRule[], scope: HlScope, text: string, occurrence: number) =>
      prev.find(
        (r) =>
          ruleScope(r) === scope &&
          r.text === text &&
          !r.case_sensitive &&
          (scope === "keyword" || (r.occurrence ?? 0) === occurrence),
      ),
    [],
  );

  // 탭: 색 순환(없으면 노랑 → … → 보라 → 해제). scope 에 따라 키워드/선택-부분 규칙을 만든다.
  const cycle = useCallback(
    (scope: HlScope, text: string, occurrence: number) => {
      const kindLabel = scope === "keyword" ? "키워드 형광펜" : "형광펜";
      updateRules((prev) => {
        const existing = findRule(prev, scope, text, occurrence);
        if (!existing) {
          const rule: HighlightRule = {
            id: newId(),
            text,
            color: "yellow",
            style: "fill",
            case_sensitive: false,
            whole_word: scope === "keyword", // 키워드만 단어 경계, passage 는 선택 구절 그대로
            label: null,
            note: null,
            created_at: new Date().toISOString(),
            scope,
            ...(scope === "passage" ? { occurrence } : {}),
          };
          flashStatus(`${COLOR_LABEL.yellow} ${kindLabel}`);
          setDim(text); // 색이 보이도록 선택 배경 숨김
          return [...prev, rule];
        }
        const i = CYCLE.indexOf(existing.color);
        if (i >= CYCLE.length - 1) {
          flashStatus(`${kindLabel} 해제`);
          setDim(null); // 칠한 게 없으니 선택 배경 복원
          return prev.filter((r) => r.id !== existing.id);
        }
        const next = CYCLE[i + 1];
        flashStatus(`${COLOR_LABEL[next]} ${kindLabel}`);
        setDim(text);
        return prev.map((r) => (r.id === existing.id ? { ...r, color: next } : r));
      });
    },
    [updateRules, findRule, flashStatus, setDim],
  );

  // 툴바 스와치: 순환 대신 지정 색. 없으면 그 색으로 생성, 같은 색이면 해제, 다른 색이면 변경.
  const paint = useCallback(
    (scope: HlScope, text: string, occurrence: number, color: HlColor) => {
      const kindLabel = scope === "keyword" ? "키워드 형광펜" : "형광펜";
      updateRules((prev) => {
        const existing = findRule(prev, scope, text, occurrence);
        if (existing && existing.color === color) {
          flashStatus(`${kindLabel} 해제`);
          setDim(null);
          return prev.filter((r) => r.id !== existing.id);
        }
        flashStatus(`${COLOR_LABEL[color]} ${kindLabel}`);
        setDim(text);
        if (existing) return prev.map((r) => (r.id === existing.id ? { ...r, color } : r));
        const rule: HighlightRule = {
          id: newId(),
          text,
          color,
          style: "fill",
          case_sensitive: false,
          whole_word: scope === "keyword",
          label: null,
          note: null,
          created_at: new Date().toISOString(),
          scope,
          ...(scope === "passage" ? { occurrence } : {}),
        };
        return [...prev, rule];
      });
    },
    [updateRules, findRule, flashStatus, setDim],
  );

  // 현재 선택에 적용 — 키 탭과 툴바가 같은 길을 탄다. passage 는 선택이 같은 텍스트의 몇 번째 출현인지 고정.
  const applyToSelection = useCallback(
    (scope: HlScope, color?: HlColor): { text: string; occurrence: number } | null => {
      const sel = readSelection();
      if (!sel) return null;
      let occurrence = 0;
      if (scope === "passage") {
        const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
        if (container) occurrence = occurrenceOf(container, sel.text, sel.range);
      }
      if (color && CYCLE.includes(color)) paint(scope, sel.text, occurrence, color);
      else cycle(scope, sel.text, occurrence); // 탭: 즉시 색 순환(생성/순환/해제)
      return { text: sel.text, occurrence };
    },
    [readSelection, cycle, paint],
  );

  // 홀드: 즉시 제거
  const removeMatch = useCallback(
    (scope: HlScope, text: string, occurrence: number) => {
      updateRules((prev) => {
        const existing = findRule(prev, scope, text, occurrence);
        if (!existing) return prev;
        flashStatus(scope === "keyword" ? "키워드 형광펜 제거" : "형광펜 제거");
        setDim(null);
        return prev.filter((r) => r.id !== existing.id);
      });
    },
    [updateRules, findRule, flashStatus, setDim],
  );

  // ── 키보드: 탭(즉시 색 순환) / 홀드(키 반복 = 제거) ─────────────────
  // 예전엔 keyup 타이밍으로 탭/홀드를 갈랐는데, 조합키(⇧H)를 누른 채로는 문자 키의
  // keyup 이 유실되는 경우가 있어(macOS/Chromium) 탭이 '제거'로 오판돼 ⇧H 가 먹지
  // 않았다. 이제 탭은 keydown 에서 바로 적용하고, 홀드 제거는 OS 키 반복(e.repeat)이
  // HOLD_MS 를 넘겼을 때만 한다 — keyup 에 의존하지 않아 조합키에서도 안정적.
  useEffect(() => {
    const scopeOf = (e: KeyboardEvent): HlScope | null =>
      matchCombo(e, keymap.highlight) // 키워드(전부) vs 선택-부분(이 부분만)
        ? "keyword"
        : matchCombo(e, keymap.highlightPassage)
          ? "passage"
          : null;

    const onDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const scope = scopeOf(e);
      if (!scope) return;
      const key = baseKey(e) ?? "";

      // 키 반복(꾹 누름) → HOLD_MS 지나면 해당 규칙 제거(1회).
      if (e.repeat) {
        const p = press.current;
        if (p && p.key === key && p.scope === scope && !p.removed && Date.now() - p.startedAt >= HOLD_MS) {
          p.removed = true;
          removeMatch(scope, p.text, p.occurrence);
        }
        e.preventDefault();
        return;
      }

      const hit = applyToSelection(scope);
      if (!hit) return; // 선택 없으면 통과(다른 입력 방해 안 함)
      e.preventDefault();
      press.current = { key, scope, text: hit.text, occurrence: hit.occurrence, startedAt: Date.now(), removed: false };
      // 선택은 유지 → 연속 탭으로 색 순환 가능
    };

    const onUp = (e: KeyboardEvent) => {
      const p = press.current;
      if (p && baseKey(e) === p.key) press.current = null;
    };

    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      press.current = null;
    };
  }, [keymap.highlight, keymap.highlightPassage, applyToSelection, removeMatch]);

  // 선택 툴바(galpi:action) — 키 탭과 같은 경로. 선택이 본문 밖이면 readSelection 이 걸러 아무것도 안 한다.
  useEffect(
    () =>
      onAction((a) => {
        if (a.id === "highlightPassage") applyToSelection("passage", a.color);
        else if (a.id === "highlight") applyToSelection("keyword", a.color);
      }),
    [applyToSelection],
  );

  return status ? <div className="hl-status">{status}</div> : null;
}
