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

## 원문 + 번역 PDF 저장

논문 상단의 **내보내기** 버튼에서 저장 미리보기를 연다. A3/A4 가로 용지,
원문과 번역의 좌우 폭, 번역 글자 크기(pt), 줄간격을 조정하고 **PDF 저장**을 누르면
저장 위치를 선택할 수 있다. 번역의 위·아래·좌우 여백도 mm 단위로 조정한다.
이 설정은 앱 공통 기본값으로 저장해 다른 논문이나 앱 재시작 후에도 바로 불러온다.

원문 PDF의 텍스트와 벡터 도표를 그대로 삽입한다. 긴 번역은 페이지별로 글자 크기와
줄간격(최소 8pt·1.2)을 먼저 줄이고, 그래도 넘치면 여백을 줄인다. 그래도 들어가지
않으면 같은 원문을 왼쪽에 반복한 다음 장으로 이어진다. 자동 축소는 저장된 기본값을
바꾸지 않으며, 현재 장의 실제 글자·줄간격을 미리보기에 표시한다.
미번역 문단은 표시를 남기고, 원문 추출 중에는 저장을
기다린다. 기존 HTML 내보내기는 미리보기 왼쪽 아래에서 사용할 수 있다.

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
