# Paper Reflow Reader

원어(영어) 금융·경제 논문 PDF를 고품질로 추출해, 타이포그래피를 자유롭게 조정하며 읽는
**리플로우 뷰어**. macOS 우선(Apple Silicon), 코드는 Windows 이식 가능하게 작성.

명세: [PAPER_READER_SPEC.md](PAPER_READER_SPEC.md) · 진행 계획: [PLAN.md](PLAN.md)

## 구조

```
pipeline/   1단계 — PDF 추출 파이프라인 (Python + MinerU + PyMuPDF)
app/        2단계 — 리플로우 뷰어 (Electron + React + TypeScript + Vite)
```

두 단계는 중간 포맷 `document.json`(명세 §5)을 계약으로 분리된다.

## 개발 셋업

### 1단계 (pipeline)

```bash
cd pipeline
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# 추출 실행
python extract.py <input.pdf> <output_dir>
```

### 2단계 (app)

```bash
cd app
npm install
npm run dev        # Vite dev 서버 + Electron
```

## 플랫폼

- **macOS (Apple Silicon)**: MinerU MLX 백엔드로 가속. 주 타깃.
- **Windows**: 뷰어는 동작. 추출은 `pipeline`/CUDA 백엔드 필요(미검증).
