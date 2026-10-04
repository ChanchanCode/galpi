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
원문과 번역의 좌우 폭, 번역 글꼴·글자 크기(pt)·줄간격·문단 간격을 조정하고 **PDF 저장**을 누르면
저장 위치를 선택할 수 있다. 종이 바깥 여백, 원문과 번역 사이 간격, 번역 칸 안쪽의
위·아래·좌우 여백을 각각 mm 단위로 조정한다. 슬라이더·증감 버튼·숫자 입력을 사용할 수 있다.
이 설정은 앱 공통 기본값으로 저장해 다른 논문이나 앱 재시작 후에도 바로 불러온다.

원문 PDF의 텍스트와 벡터 도표를 그대로 삽입한다. **살짝 넘치는 쪽만 글자 크기 줄이기**를
켜면 해당 원문 쪽의 번역 글자만 최대 10%(최소 8pt) 줄여 한 장에 맞춘다. 줄간격 배율과 여백은
유지하며, 현재 쪽의 실제 크기를 미리보기에 표시한다. 크게 넘치는 번역은 같은 원문을 왼쪽에
반복한 다음 장으로 이어진다. 설정을 바꾸어도 보고 있던
원문 쪽을 유지한다. 한 장 전체/가로 맞춤과 50–125% 확대, 페이지 선택, 기본 배치 초기화를 제공한다.
미번역 문단은 표시를 남기고, 원문 추출 중에는 저장을
기다린다. 기존 HTML 내보내기는 미리보기 왼쪽 아래에서 사용할 수 있다.

기본 PDF 파일명은 `Ben-David et al. (2018) - Do ETFs Increase Volatility - 원문+번역.pdf`처럼
저자·연도·제목을 포함한다. 원문 첫 페이지의 저널 발행 정보, 작성일 또는 저작권 연도를 사용하며,
본문에서 인용한 연도와 PDF 파일 생성일은 쓰지 않는다. 확인할 수 없는 정보는 미상으로 표시한다.

PDF 회귀 검증은 `cd app && npm run test:pdf`로 실행한다. 실제 Electron 미리보기·저장 경로를
격리된 임시 데이터로 검사하며, 사용자 라이브러리나 AI 서비스를 수정·호출하지 않는다.

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
