// 키워드 형광펜 (명세 §8) — 단축키 전용. (사용자 요청: 선택 시 뜨던 미니 툴바 제거,
// text 위 hover UI 금지.) 본문에서 텍스트 선택 후:
//   · 단축키 탭 → 색 순환(노랑→초록→파랑→분홍→보라→해제)
//   · 단축키 꾹 누름 → 즉시 제거
// 같은 텍스트가 문서 전체에서 함께 칠해진다.
// 상태(규칙)는 useAnnotations 훅이 소유하고 props 로 내려준다(제어형). 본 레이어는
// "본문 적용 + 키보드 생성/순환/제거 + 출현 수 집계"만 담당하고, 목록 UI 는 AnnotationsPanel 이 그린다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import { useStore } from "../store/useStore";
import { baseKey, isEditableTarget, matchCombo } from "../keys/keymap";
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
  // 누름 추적: 같은 키 keydown→keyup 구간으로 탭/홀드 판별
  const press = useRef<{
    key: string;
    scope: HlScope;
    text: string;
    occurrence: number;
    held: boolean;
    timer: ReturnType<typeof setTimeout>;
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

  // ── 키보드: 탭/홀드 판별 ─────────────────────────────────────────
  // keydown 에 바인딩이 정확히 일치하면 누름 시작, 같은 물리 키의 keyup 으로 종료.
  // (기본 H. 수식 조합으로 바꿔도 동작 — keyup 은 글자 키 release 로 판정.)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;
      // 어떤 형광펜인지 — 키워드(전부) vs 선택-부분(이 부분만). 수식 키가 달라 충돌 없음.
      const scope: HlScope | null = matchCombo(e, keymap.highlight)
        ? "keyword"
        : matchCombo(e, keymap.highlightPassage)
          ? "passage"
          : null;
      if (!scope) return;
      const sel = readSelection();
      if (!sel) return; // 선택 없으면 통과(다른 입력 방해 안 함)
      e.preventDefault();
      // passage 는 선택이 같은 텍스트의 몇 번째 출현인지 고정.
      let occurrence = 0;
      if (scope === "passage") {
        const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
        if (container) occurrence = occurrenceOf(container, sel.text, sel.range);
      }
      if (press.current) clearTimeout(press.current.timer);
      const timer = setTimeout(() => {
        if (press.current) {
          press.current.held = true;
          removeMatch(press.current.scope, press.current.text, press.current.occurrence);
        }
      }, HOLD_MS);
      press.current = { key: baseKey(e) ?? "", scope, text: sel.text, occurrence, held: false, timer };
    };
    const onUp = (e: KeyboardEvent) => {
      const p = press.current;
      if (!p || baseKey(e) !== p.key) return;
      clearTimeout(p.timer);
      if (!p.held) cycle(p.scope, p.text, p.occurrence); // 탭
      press.current = null;
      // 선택은 유지 → 연속 탭으로 색 순환 가능
    };
    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    };
  }, [keymap.highlight, keymap.highlightPassage, readSelection, cycle, removeMatch]);

  return status ? <div className="hl-status">{status}</div> : null;
}
