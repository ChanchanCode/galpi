// 채팅 상태 — 세션 목록·현재 세션·스트리밍·입력 초안(인용·첨부)을 문서 단위로 들고 있다.
//
// 스트리밍 중인 한 턴은 세션 메시지에 바로 섞지 않고 `tail` 로 따로 둔다. 끝나면 디스크에서
// 세션을 다시 읽어(저장된 게 정답) tail 을 버린다 — 임시 id 와 저장된 id 를 맞추는 일을 안 하려고.
// 액션은 한 번만 만들고 상태는 ref 로 읽는다: 콜백이 매 렌더 바뀌면 메시지 목록 memo 가 다 깨진다.
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatAttachment,
  ChatContextMode,
  ChatMessage,
  ChatModelInfo,
  ChatQuote,
  ChatSendResult,
  ChatSession,
  ChatSessionMeta,
} from "../../electron/preload";
import { DEFAULT_CHAT_MODEL } from "../../electron/ai/chatTypes";
import type { PaperDocument } from "../types";
import { uploadImageBlob } from "./chatBus";

const MAX_ATTACH = 10;

interface Tail {
  sessionId: string; // "" = 첫 전송이라 세션을 만드는 중
  jobId: string;
  user: ChatMessage | null; // 재생성이면 null
  assistant: ChatMessage;
  regenerate: boolean;
}

export interface Draft {
  text: string;
  quotes: ChatQuote[];
  attachments: ChatAttachment[];
  uploading: number;
}

interface State {
  docId: string;
  sessions: ChatSessionMeta[];
  session: ChatSession | null;
  tail: Tail | null;
  models: ChatModelInfo[];
  defaultModel: string;
  model: string;
  context: ChatContextMode;
  draft: Draft;
  focusTick: number;
  scrollTick: number;
}

type SendInput = { text: string; quotes: ChatQuote[]; attachments: ChatAttachment[] };

const EMPTY_DRAFT: Draft = { text: "", quotes: [], attachments: [], uploading: 0 };

const nowIso = () => new Date().toISOString();

function toMeta(s: ChatSession): ChatSessionMeta {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, model: s.model, n: s.messages.length };
}

function upsertMeta(list: ChatSessionMeta[], m: ChatSessionMeta): ChatSessionMeta[] {
  return [m, ...list.filter((x) => x.id !== m.id)];
}

function errOf(e: unknown): { kind: string; message: string } {
  return { kind: "network", message: e instanceof Error ? e.message : String(e) };
}

export function useChat(doc: PaperDocument) {
  const docId = doc.doc_id;
  const [st, setSt] = useState<State>(() => ({
    docId,
    sessions: [],
    session: null,
    tail: null,
    models: [],
    defaultModel: DEFAULT_CHAT_MODEL,
    model: DEFAULT_CHAT_MODEL,
    context: "full",
    draft: EMPTY_DRAFT,
    focusTick: 0,
    scrollTick: 0,
  }));
  const ref = useRef(st);
  const set = (fn: (s: State) => State) => {
    ref.current = fn(ref.current);
    setSt(ref.current);
  };
  const docRef = useRef(doc);
  docRef.current = doc;
  // 문서가 바뀌면 gen 이 오른다 — 이전 문서의 늦게 온 응답·델타는 전부 버린다.
  const gen = useRef(0);
  const loadSeq = useRef(0);
  const buf = useRef("");
  const flushRaf = useRef<number | null>(null);
  // 저장되지 않은(IPC 실패 등) 오류 답변 → 재시도할 때 다시 보낼 입력
  const retryInputs = useRef(new Map<string, SendInput>());

  const actions = useMemo(() => {
    const cur = () => ref.current;

    const cancelFlush = () => {
      if (flushRaf.current != null) cancelAnimationFrame(flushRaf.current);
      flushRaf.current = null;
    };

    // 델타마다 setState 하면 토큰당 리렌더다 — 프레임당 한 번으로 묶는다.
    const scheduleFlush = (jobId: string) => {
      if (flushRaf.current != null) return;
      flushRaf.current = requestAnimationFrame(() => {
        flushRaf.current = null;
        const t = cur().tail;
        if (!t || t.jobId !== jobId) return;
        set((s) => ({ ...s, tail: s.tail && { ...s.tail, assistant: { ...s.tail.assistant, text: buf.current } } }));
      });
    };

    const loadSession = async (id: string): Promise<void> => {
      const g = gen.current;
      const seq = ++loadSeq.current;
      let s: ChatSession | null = null;
      try {
        s = await window.paperAPI.chatLoad(cur().docId, id);
      } catch {
        s = null;
      }
      if (g !== gen.current || seq !== loadSeq.current) return;
      if (!s) {
        set((x) => ({ ...x, sessions: x.sessions.filter((m) => m.id !== id) }));
        return;
      }
      const loaded = s;
      set((x) => {
        // 답을 받는 중인 세션으로 돌아왔다 — 사용자 메시지는 이미 저장돼 있으니 임시 것은 숨긴다.
        const t = x.tail;
        const tail = t && t.sessionId === id && t.user && loaded.messages[loaded.messages.length - 1]?.role === "user" ? { ...t, user: null } : t;
        return { ...x, session: loaded, tail, model: loaded.model || x.defaultModel, context: loaded.context ?? "full", scrollTick: x.scrollTick + 1 };
      });
    };

    /** 끝난 턴 반영 — 디스크 세션을 다시 읽고, 저장 안 된 오류만 로컬로 덧붙인다. */
    const finish = async (g: number, jobId: string, sessionId: string, res: ChatSendResult, input: SendInput | null) => {
      cancelFlush();
      if (g !== gen.current) return;
      if (res.session) {
        const meta = res.session;
        set((s) => ({ ...s, sessions: upsertMeta(s.sessions, meta), session: s.session?.id === meta.id ? { ...s.session, title: meta.title, model: meta.model } : s.session }));
      }
      const t0 = cur().tail;
      if (!t0 || t0.jobId !== jobId) return;
      if (cur().session?.id !== sessionId) {
        set((s) => ({ ...s, tail: null }));
        return;
      }
      let loaded: ChatSession | null = null;
      try {
        loaded = await window.paperAPI.chatLoad(cur().docId, sessionId);
      } catch {
        loaded = null;
      }
      if (g !== gen.current) return;
      const s = cur();
      const t = s.tail;
      if (!t || t.jobId !== jobId) return;
      if (s.session?.id !== sessionId) {
        set((x) => ({ ...x, tail: null }));
        return;
      }
      const base = loaded ?? s.session;
      let messages = base.messages;
      if (!loaded) {
        // 다시 못 읽었으면 로컬로 접는다 — tail 을 버리면 방금 턴이 화면에서 사라진다.
        if (t.regenerate && messages[messages.length - 1]?.role === "assistant") messages = messages.slice(0, -1);
        if (t.user) messages = [...messages, res.userMessage ?? t.user];
        messages = [...messages, res.message ?? { ...t.assistant, text: buf.current }];
      }
      if (!res.message) {
        // 저장되지 않은 오류 — 화면에만 붙이고 재시도 입력을 기억한다.
        const err: ChatMessage = { ...t.assistant, text: buf.current, status: "error", error: res.error ?? { kind: "server", message: "" } };
        const userSaved = !!res.userMessage || (!!loaded && !!t.user && loaded.messages[loaded.messages.length - 1]?.role === "user");
        messages = loaded ? [...loaded.messages, ...(t.user && !userSaved ? [t.user] : []), err] : [...messages.slice(0, -1), err];
        // 사용자 메시지가 저장됐으면 재시도 = 재생성(같은 질문이 두 번 저장되지 않게), 아니면 입력째 다시 보낸다.
        if (input && !userSaved) retryInputs.current.set(err.id, input);
      }
      set((x) => ({ ...x, session: { ...base, messages }, tail: null }));
    };

    const runJob = async (sessionId: string, input: SendInput | null, regenerate: boolean, jobId: string) => {
      const g = gen.current;
      const s = cur();
      buf.current = "";
      const onDelta = (d: string) => {
        if (g !== gen.current || cur().tail?.jobId !== jobId) return;
        buf.current += d;
        scheduleFlush(jobId);
      };
      let res: ChatSendResult;
      try {
        res = await window.paperAPI.chatSend(
          {
            docId: s.docId,
            docTitle: docRef.current.title ?? s.docId,
            sessionId,
            text: input?.text ?? "",
            quotes: input?.quotes.length ? input.quotes : undefined,
            attachments: input?.attachments.length ? input.attachments : undefined,
            model: s.model,
            context: s.context,
            jobId,
            regenerate: regenerate || undefined,
          },
          onDelta,
        );
      } catch (e) {
        res = { error: errOf(e) };
      }
      await finish(g, jobId, sessionId, res, input);
    };

    /** 전송. extra 가 없으면 입력창 초안(인용·첨부)을 쓰고 비운다. 받아들였으면 true. */
    const send = async (
      textIn: string,
      extra?: { quotes?: ChatQuote[]; attachments?: ChatAttachment[]; newSession?: boolean },
    ): Promise<boolean> => {
      const s0 = cur();
      if (s0.tail) return false;
      const text = textIn.trim();
      const useDraft = !extra || (extra.quotes === undefined && extra.attachments === undefined);
      const quotes = useDraft ? s0.draft.quotes : extra?.quotes ?? [];
      const attachments = useDraft ? s0.draft.attachments : extra?.attachments ?? [];
      if (!text && !quotes.length && !attachments.length) return false;
      const input: SendInput = { text, quotes, attachments };
      const g = gen.current;
      const jobId = window.paperAPI.newJobId();
      const ts = nowIso();
      // id "" = 세션 생성에 실패해 화면에만 있는 임시 세션 → 다음 전송은 새로 만든다
      const fresh = !!extra?.newSession || !s0.session?.id;
      const user: ChatMessage = {
        id: `tmp_u_${jobId}`,
        role: "user",
        text,
        ts,
        quotes: quotes.length ? quotes : undefined,
        attachments: attachments.length ? attachments : undefined,
      };
      const assistant: ChatMessage = { id: `tmp_a_${jobId}`, role: "assistant", text: "", ts, model: s0.model };
      set((s) => ({
        ...s,
        session: fresh ? null : s.session,
        tail: { sessionId: fresh ? "" : s.session!.id, jobId, user, assistant, regenerate: false },
        draft: useDraft ? { ...s.draft, text: "", quotes: [], attachments: [] } : s.draft,
        scrollTick: s.scrollTick + 1,
      }));
      let sessionId = fresh ? "" : s0.session!.id;
      if (fresh) {
        try {
          const created = await window.paperAPI.chatCreate(s0.docId, { model: s0.model, context: s0.context });
          if (g !== gen.current) return true;
          // main 은 문서 폴더·document.json 이 없으면 null 을 돌려준다(던지지 않는다) — 아래 catch 로 모은다.
          if (!created) throw new Error("대화를 만들 수 없습니다.");
          sessionId = created.id;
          set((s) => ({
            ...s,
            session: s.tail?.jobId === jobId ? created : s.session,
            sessions: upsertMeta(s.sessions, toMeta(created)),
            tail: s.tail?.jobId === jobId ? { ...s.tail, sessionId: created.id } : s.tail,
          }));
        } catch (e) {
          if (g !== gen.current) return true;
          // 세션조차 못 만들었다 — 화면에만 있는 임시 세션(id "")에 오류를 보이고 재시도 입력을 기억한다.
          const err: ChatMessage = { ...assistant, status: "error", error: errOf(e) };
          retryInputs.current.set(err.id, input);
          set((s) =>
            s.tail?.jobId !== jobId
              ? s
              : {
                  ...s,
                  tail: null,
                  session: { v: 1, id: "", docId: s.docId, title: "", createdAt: ts, updatedAt: ts, model: s.model, context: s.context, messages: [user, err] },
                },
          );
          return true;
        }
      }
      await runJob(sessionId, input, false, jobId);
      return true;
    };

    const regenerate = async (): Promise<void> => {
      const s0 = cur();
      if (s0.tail || !s0.session?.id) return;
      const jobId = window.paperAPI.newJobId();
      const assistant: ChatMessage = { id: `tmp_a_${jobId}`, role: "assistant", text: "", ts: nowIso(), model: s0.model };
      set((s) => ({ ...s, tail: { sessionId: s0.session!.id, jobId, user: null, assistant, regenerate: true } }));
      await runJob(s0.session.id, null, true, jobId);
    };

    const retry = async (messageId: string): Promise<void> => {
      const s0 = cur();
      if (s0.tail || !s0.session) return;
      const input = retryInputs.current.get(messageId);
      if (!input) return regenerate();
      retryInputs.current.delete(messageId);
      // 저장 안 된 로컬 턴(임시 user + 오류)을 걷어 내고 같은 입력으로 다시 보낸다.
      const msgs = s0.session.messages;
      const idx = msgs.findIndex((m) => m.id === messageId);
      const drop = idx > 0 && msgs[idx - 1].id.startsWith("tmp_u_") ? idx - 1 : idx;
      set((s) => ({ ...s, session: s.session && { ...s.session, messages: s.session.messages.slice(0, drop < 0 ? undefined : drop) } }));
      await send(input.text, { quotes: input.quotes, attachments: input.attachments });
    };

    const cancel = () => {
      const t = cur().tail;
      if (t) void window.paperAPI.chatCancel(t.jobId).catch(() => {});
    };

    const newSession = () => {
      set((s) => ({ ...s, session: null, scrollTick: s.scrollTick + 1, focusTick: s.focusTick + 1 }));
    };

    const openSession = (id: string) => {
      if (cur().session?.id === id) return;
      void loadSession(id);
    };

    const renameSession = async (id: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      const g = gen.current;
      const meta = await window.paperAPI.chatUpdate(cur().docId, id, { title: t }).catch(() => null);
      if (!meta || g !== gen.current) return;
      set((s) => ({
        ...s,
        sessions: s.sessions.map((m) => (m.id === id ? { ...m, title: meta.title } : m)),
        session: s.session?.id === id ? { ...s.session, title: meta.title } : s.session,
      }));
    };

    const deleteSession = async (id: string) => {
      if (cur().tail?.sessionId === id) return; // 답을 받는 중인 세션은 못 지운다
      const g = gen.current;
      const ok = await window.paperAPI.chatDelete(cur().docId, id).catch(() => false);
      if (!ok || g !== gen.current) return;
      const wasCurrent = cur().session?.id === id;
      set((s) => ({ ...s, sessions: s.sessions.filter((m) => m.id !== id), session: wasCurrent ? null : s.session }));
      const next = cur().sessions[0];
      if (wasCurrent && next) void loadSession(next.id);
    };

    const setModel = (id: string) => {
      const s = cur();
      set((x) => ({ ...x, model: id, defaultModel: id, session: x.session && { ...x.session, model: id } }));
      if (s.session?.id) {
        const sid = s.session.id;
        void window.paperAPI.chatUpdate(s.docId, sid, { model: id }).then((meta) => {
          if (meta) set((x) => ({ ...x, sessions: x.sessions.map((m) => (m.id === sid ? { ...m, model: meta.model } : m)) }));
        }).catch(() => {});
      }
      void window.paperAPI.setChatModel(id).catch(() => {});
    };

    const setContext = (mode: ChatContextMode) => {
      const s = cur();
      set((x) => ({ ...x, context: mode, session: x.session && { ...x.session, context: mode } }));
      if (s.session?.id) void window.paperAPI.chatUpdate(s.docId, s.session.id, { context: mode }).catch(() => {});
    };

    const setText = (text: string) => set((s) => ({ ...s, draft: { ...s.draft, text } }));

    const addQuote = (q: ChatQuote) => {
      if (!q?.text?.trim()) return;
      set((s) =>
        s.draft.quotes.some((x) => x.text === q.text && x.blockId === q.blockId)
          ? s
          : { ...s, draft: { ...s.draft, quotes: [...s.draft.quotes, q] } },
      );
    };
    const removeQuote = (i: number) =>
      set((s) => ({ ...s, draft: { ...s.draft, quotes: s.draft.quotes.filter((_, k) => k !== i) } }));

    const addAttachment = (a: ChatAttachment) => {
      if (!a?.file) return;
      set((s) =>
        s.draft.attachments.length >= MAX_ATTACH || s.draft.attachments.some((x) => x.file === a.file)
          ? s
          : { ...s, draft: { ...s.draft, attachments: [...s.draft.attachments, a] } },
      );
    };
    const removeAttachment = (id: string) =>
      set((s) => ({ ...s, draft: { ...s.draft, attachments: s.draft.attachments.filter((a) => a.id !== id) } }));

    /** 붙여넣기·드롭·파일 선택 이미지 → 저장 후 첨부 */
    const uploadBlobs = (blobs: Blob[]) => {
      const imgs = blobs.filter((b) => /^image\//.test(b.type)).slice(0, MAX_ATTACH);
      if (!imgs.length) return;
      const g = gen.current;
      const d = cur().docId;
      set((s) => ({ ...s, draft: { ...s.draft, uploading: s.draft.uploading + imgs.length } }));
      for (const b of imgs) {
        void uploadImageBlob(d, b, { name: b instanceof File ? b.name : undefined })
          .catch(() => null)
          .then((a) => {
            if (g !== gen.current) return;
            set((s) => ({ ...s, draft: { ...s.draft, uploading: Math.max(0, s.draft.uploading - 1) } }));
            if (a) addAttachment(a);
          });
      }
    };

    /** 선택 툴바의 "AI에게…" — 답을 받는 중이면 초안으로 넘긴다(대기열을 두지 않는다). */
    const ask = (e: { text: string; quotes?: ChatQuote[]; attachments?: ChatAttachment[]; newSession?: boolean }) => {
      if (cur().tail) {
        e.quotes?.forEach(addQuote);
        e.attachments?.forEach(addAttachment);
        set((s) => ({ ...s, draft: { ...s.draft, text: s.draft.text || e.text }, focusTick: s.focusTick + 1 }));
        return;
      }
      void send(e.text, { quotes: e.quotes ?? [], attachments: e.attachments ?? [], newSession: e.newSession });
    };

    const requestFocus = () => set((s) => ({ ...s, focusTick: s.focusTick + 1 }));

    return {
      send, regenerate, retry, cancel, newSession, openSession, renameSession, deleteSession,
      setModel, setContext, setText, addQuote, removeQuote, addAttachment, removeAttachment, uploadBlobs, ask, requestFocus,
      loadSession,
    };
  }, []);

  // 모델 목록 — 패널 수명 동안 한 번. 기본값은 새 세션에만 쓰인다.
  useEffect(() => {
    let alive = true;
    window.paperAPI
      .chatModels()
      .then((l) => {
        if (!alive) return;
        set((s) => ({ ...s, models: l.models, defaultModel: l.default, model: s.session ? s.model : l.default }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 문서 전환 — 상태를 비우고 그 문서의 가장 최근 세션을 연다. 진행 중인 답은 main 이 끝까지 받아 저장한다.
  useEffect(() => {
    const g = ++gen.current;
    if (flushRaf.current != null) cancelAnimationFrame(flushRaf.current);
    flushRaf.current = null;
    retryInputs.current.clear();
    set((s) => ({ ...s, docId, sessions: [], session: null, tail: null, model: s.defaultModel, context: "full", draft: EMPTY_DRAFT }));
    window.paperAPI
      .chatList(docId)
      .then((list) => {
        if (g !== gen.current) return;
        set((s) => ({ ...s, sessions: list }));
        if (list[0]) void actions.loadSession(list[0].id);
      })
      .catch(() => {});
  }, [docId]);

  useEffect(
    () => () => {
      if (flushRaf.current != null) cancelAnimationFrame(flushRaf.current);
    },
    [],
  );

  // 화면에 그릴 메시지 — 저장된 것 + 진행 중 턴
  const messages = useMemo(() => {
    const base = st.session?.messages ?? [];
    const t = st.tail;
    if (!t || t.sessionId !== (st.session?.id ?? "")) return base;
    const head = t.regenerate && base[base.length - 1]?.role === "assistant" ? base.slice(0, -1) : base;
    return [...head, ...(t.user ? [t.user] : []), t.assistant];
  }, [st.session, st.tail]);

  return {
    ...actions,
    docId: st.docId,
    sessions: st.sessions,
    session: st.session,
    messages,
    streamingId: st.tail && st.tail.sessionId === (st.session?.id ?? "") ? st.tail.assistant.id : null,
    busy: !!st.tail,
    busySessionId: st.tail?.sessionId ?? null,
    models: st.models,
    model: st.model,
    context: st.context,
    draft: st.draft,
    focusTick: st.focusTick,
    scrollTick: st.scrollTick,
  };
}

export type ChatApi = ReturnType<typeof useChat>;
