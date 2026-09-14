// 채팅 이벤트 버스 (계약 파일) — 본문 쪽(선택 툴바·그림 메뉴·원본 지면 크롭)이 채팅 패널에 뭔가를 넘기는 유일한 길.
// App 은 "열기"만 듣고, ChatPanel 은 내용(quote/attach/ask)을 듣는다. ChatPanel 은 리더에 늘 마운트돼 있다
// (닫혀 있으면 숨김) — 그래서 버퍼링이 필요 없다.
import type { ChatAttachment, ChatQuote } from "../../electron/preload";

export type ChatTab = "chat" | "summary";

export type ChatBusEvent =
  | { type: "open"; tab?: ChatTab }
  | { type: "toggle" }
  /** 입력창 위 인용 칩으로 추가 + 패널 열기 + 입력창 포커스 */
  | { type: "quote"; quote: ChatQuote }
  /** 첨부 썸네일로 추가 + 패널 열기 */
  | { type: "attach"; attachment: ChatAttachment }
  /** 바로 전송(선택 툴바의 "AI에게…" 입력·"설명" 버튼). newSession=true 면 새 대화에서. */
  | { type: "ask"; text: string; quotes?: ChatQuote[]; attachments?: ChatAttachment[]; newSession?: boolean };

const EVT = "galpi:chat";

export function emitChat(e: ChatBusEvent): void {
  window.dispatchEvent(new CustomEvent<ChatBusEvent>(EVT, { detail: e }));
}

export function onChat(cb: (e: ChatBusEvent) => void): () => void {
  const h = (ev: Event) => cb((ev as CustomEvent<ChatBusEvent>).detail);
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}

const MAX_EDGE = 1600; // 긴 변 상한 — 원본 페이지 통째는 수만 토큰이다(PLAN-AI P5)

/** Blob(붙여넣기·드롭·캔버스 크롭) → 긴 변 1600px 이하 PNG/JPEG → main 에 저장 → 첨부 메타. 실패 시 null. */
export async function uploadImageBlob(
  docId: string,
  blob: Blob,
  opts: { name?: string; source?: { blockId?: string; page?: number } } = {},
): Promise<ChatAttachment | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    let outBlob = blob;
    let mime = blob.type || "image/png";
    if (k < 1 || !/^image\/(png|jpeg|webp|gif)$/.test(mime)) {
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      mime = "image/png";
      outBlob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), mime));
    }
    bmp.close();
    const base64 = await blobToBase64(outBlob);
    const r = await window.paperAPI.chatSaveAttachment({ docId, base64, mime, name: opts.name, source: opts.source });
    return "error" in r ? null : r;
  } catch {
    return null;
  }
}

/** 이미 문서 폴더 안에 있는 그림(assets/…)은 복사 없이 참조만 한다. */
export function attachmentFromAsset(file: string, blockId?: string): ChatAttachment {
  const ext = (file.split(".").pop() ?? "png").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
  return { id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, kind: "image", file, mime, source: blockId ? { blockId } : undefined };
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}
