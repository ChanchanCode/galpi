"""로컬 오프라인 번역 서버 (명세 §1.2 보안: 논문이 외부로 안 나감).

NLLB-200-distilled-600M 으로 영→한(기본) 번역. localhost 전용 FastAPI.
Electron main 이 필요 시 자식 프로세스로 띄우고 IPC 로 프록시한다.

  python translate_server.py --port 8765

모델은 첫 요청 때 지연 로드(메모리). 로드 후엔 문장당 ~1초 수준.
"""

from __future__ import annotations

import argparse
import re
import sys

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_NAME = "facebook/nllb-200-distilled-600M"
# NLLB 언어 코드
LANGS = {"en": "eng_Latn", "ko": "kor_Hang"}

app = FastAPI()
_state: dict = {"tok": None, "model": None}


def _load():
    """모델 지연 로드 (첫 요청 시)."""
    if _state["model"] is not None:
        return
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    print(f"[translate] loading {MODEL_NAME} …", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
    # Apple Silicon MPS 가속(가능 시), 아니면 CPU
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model.to(device)
    model.eval()
    _state.update(tok=tok, model=model, device=device, torch=torch)
    print(f"[translate] ready on {device}", flush=True)


# 긴 선택문은 문장 단위로 쪼개 배치 번역(품질·길이 안정).
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _translate(text: str, src: str, tgt: str) -> str:
    _load()
    tok, model, torch = _state["tok"], _state["model"], _state["torch"]
    tok.src_lang = LANGS.get(src, "eng_Latn")
    bos = tok.convert_tokens_to_ids(LANGS.get(tgt, "kor_Hang"))

    sentences = [s for s in _SENT_SPLIT.split(text.strip()) if s.strip()] or [text]
    batch = tok(sentences, return_tensors="pt", padding=True, truncation=True, max_length=512)
    batch = {k: v.to(_state["device"]) for k, v in batch.items()}
    with torch.no_grad():
        gen = model.generate(**batch, forced_bos_token_id=bos, max_length=512, num_beams=4)
    out = tok.batch_decode(gen, skip_special_tokens=True)
    return " ".join(out)


class Req(BaseModel):
    text: str
    src: str = "en"
    tgt: str = "ko"


@app.get("/health")
def health():
    return {"ok": True, "loaded": _state["model"] is not None}


@app.post("/translate")
def translate(req: Req):
    if not req.text.strip():
        return {"translation": ""}
    return {"translation": _translate(req.text, req.src, req.tgt)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--preload", action="store_true", help="시작 시 모델 미리 로드")
    args = ap.parse_args()
    if args.preload:
        _load()
    import uvicorn

    # 127.0.0.1 바인딩 — 외부 접근 차단(로컬 전용)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
