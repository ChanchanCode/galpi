# 개발 계획 — Paper Reflow Reader

> 상위 명세: [PAPER_READER_SPEC.md](PAPER_READER_SPEC.md)
> 이 문서는 실행 계획·진행 상황 추적용. 명세가 "무엇/왜"라면 이 문서는 "언제/어떻게/어디까지".

## 플랫폼 전략 (확정)

**Mac 우선, Windows로 갈 길은 막지 않는 코드.**

- **뷰어(Electron+React)**: 크로스플랫폼 거의 공짜. 단 경로는 하드코딩(`~/Library/...`) 금지 →
  반드시 `app.getPath('userData')` 사용. 단축키 modifier도 OS별 추상화.
- **추출(Python+MinerU)**: MLX 가속은 Apple Silicon 전용. Windows는 `pipeline`/CUDA 백엔드로
  "코드는 돌 수 있게, 보장은 안 함". 백엔드 선택만 분기점으로 분리하고 Mac(MLX)만 실제 검증.

## 환경 점검 결과

- ✅ Apple Silicon(arm64) → MLX 가능
- ✅ Node 20.20.2 / npm 10.8.2
- ✅ Homebrew, git
- ⚠️ 시스템 Python 3.9.6 → MinerU는 3.10+ 필요. **별도 Python(3.12) + venv 필요.**

## Phase 진행 체크리스트

각 Phase는 검증 게이트를 통과해야 다음으로.

- [x] **Phase 0 — 부트스트랩** ✅ 완료
  - [x] git init, 모노레포 구조(`pipeline/`, `app/`) 생성 (명세 §12)
  - [x] Python 3.12 venv + MinerU 3.4.0/PyMuPDF 1.27.2 설치
  - [x] Node 워크스페이스(Electron 33 + React 18 + Vite 6 + TS 5.7) 셋업
  - [ ] 테스트용 논문 PDF 1편 확보 ← **사용자 PDF 필요 (Phase 1 차단 요소)**
  - 검증: `mineru --version`=3.4.0 OK, vite dev + Electron 기동 OK

- [x] **Phase 1 — 추출 파이프라인 골격 (§4,§5)** ✅ 완료 (실논문 검증)
  - [x] extract.py / mineru_adapter.py / rasterize.py / build_document.py 작성
  - [x] 백엔드명 3.4.0에 맞춤(`hybrid-engine --effort high`, MLX 자동가속)
  - [x] 실제 출력 캘리브레이션 완료(§14-2, Carhart 2012로 검증):
        · content_list.json = 단일 소스(순서·LaTeX·HTML), junk(header/page_number/aside_text) 제거
        · equation.text=LaTeX($$·\tag 처리), table.table_body=HTML, table_caption[]=캡션
        · **bbox = 1000 정규화 → PDF포인트 변환** (각 축 독립, **top-left 원점·y뒤집기 없음**)
        · 검증: heading bbox=[53.87,75.86,387.63,92.87] == middle.json PDF포인트 [54,76,388,93]
  - [x] `--skip-mineru`(재추출 생략 재파싱), `--inspect`(구조 덤프) 옵션
  - 검증: Carhart 140블록·수식8·표6·bbox누락0·빈블록0, 모든 bbox 페이지 범위 내 ✅

- [x] **Phase 2 — 기본 리플로우 렌더 (§6.1,§7)** ✅ 완료 (합성+실논문 검증)
  - [x] 블록 순서 렌더(문단/제목/수식 KaTeX/표 DOMPurify/그림/캡션)
  - [x] KaTeX 실패 폴백(§7): 작은 경고 점 + 원시 LaTeX
  - [x] **인라인 수식 렌더(RichText, §14-1)**: 본문 $...$ → KaTeX inline
  - [x] 넓은 display 수식 가로 스크롤(\tag 충돌 방지)
  - [x] 텍스트 이스케이프 해제(\* \& 등, 수식 구간 보존)
  - [x] `paper://` 보안 프로토콜, IPC(docs/state/settings/fonts)
  - 검증: Carhart 논문 단일컬럼 reflow, 4-팩터 모델식·복잡 회귀표·인라인수식 모두 정상 ✅

- [x] **Phase 3 — 타이포그래피 + 폰트 (§6.2,§6.3)** ✅ 완료 (실논문 검증)
  - [x] Zustand 스토어(typography) + CSS 변수 실시간 바인딩
  - [x] 설정 패널: 테마(라이트/세피아/다크)·정렬·글꼴(본문/제목)·크기·줄간격·문단간격
        ·본문폭·자간·여백·수식크기 슬라이더 + 프리셋(기본/집중/고대비)
  - [x] 폰트 커스터마이징: 내장 스택 + 사용자 .ttf/.otf 추가(@font-face 동적등록) + 미리보기
  - [x] 영속화(§10): 문서별 state.json(디바운스 저장) + 전역 settings.json 기본값
  - [x] 라이브러리 새로고침 버튼(앞서의 UX 갭 해소)
  - 검증: 다크 전환 즉시 반영 → state.json 저장 → 재실행 후 복원 확인 ✅

- [x] **추가 A — 페이지 단위 스트리밍 읽기** ✅ (사용자 요청, Phase 4 전 추가)
  - [x] extract.py 청크 추출(`--chunk`, 기본 6): 전체 래스터화 먼저 → 청크별
        MinerU(`-s/-e`) → page_idx 오프셋 보정(§14-2 검증: 범위추출시 0리셋) →
        document.json 원자적 점진 갱신 + status.json(진행률)
  - [x] main 프로세스 fs.watch → 'docs:changed' → 라이브러리 자동 갱신 +
        열린 문서 라이브 이어붙임. 추출 중 문서도 즉시 열어 읽기 가능.
  - [x] UI: 라이브러리/리더에 "추출 중 n/N p" 배지
  - 검증: 추출 도중 문서 열어 부분 읽기 + 8→16p 자동 갱신 확인 ✅
  - ⚠️ 트레이드오프: 청크마다 MinerU 모델 재로드 → 전체 시간 2~3배 증가.
    완화책: --chunk 키워 오버헤드↓(스트리밍 입자↑), --chunk 0=단일추출(최속),
    차후 persistent mineru-api 서버로 근본 개선 가능.

- [x] **추가 B — 선택 텍스트 로컬 번역** ✅ (사용자 요청)
  - [x] translate_server.py: NLLB-200-distilled-600M, FastAPI localhost 전용
        (§1.2 보안: 논문 외부 전송 없음). 문장 분할 배치 번역. 모델 지연 로드.
  - [x] main: 번역 서버 lazy spawn + health 폴링 + translate:text 프록시
  - [x] SelectionTranslate: 드래그 선택 → "번역(T)" 플로팅 버튼/단축키 → 팝오버
  - 검증: 추출중 문서에서 문장 선택→번역→한국어 결과 표시(완전 오프라인) ✅
  - 메모: opus-mt-tc-big-en-ko 는 출력 깨져 폐기, NLLB(~2.4GB)로 확정.

- [ ] **Phase 4 — 원본 대조 Source Peek (§9)**  ← 좌표 정합 까다로움
  - [ ] 디버그 오버레이 모드 먼저 → 좌표 변환식 캘리브레이션(y 뒤집기, §9.3)
  - [ ] 검사 모드(Option+클릭) → bbox crop 팝오버
  - 검증: 정확한 원본 영역 crop

- [ ] **Phase 5 — 키워드 형광펜 (§8)**
  - [ ] CSS Custom Highlight API로 동일 텍스트 자동 하이라이트 + 영구 저장
  - 검증: reflow 후에도 하이라이트 유지

- [ ] **Phase 6 — 패키징 & 라이브러리 뷰 (§13-6)**
  - [ ] electron-builder `.app`, 경로 `app.getPath()` 추상화, 문서 목록 뷰
  - 검증: 더블클릭 실행되는 .app

- [ ] **Phase 7+ — §11 추가 기능** (목차/검색/split view/수식 인라인 편집 …)

## 리스크

1. MinerU 수식 LaTeX 정확도 (최우선 요구) — Phase 1에서 조기 확인
2. bbox 좌표계 버전차 — 디버그 오버레이 필수 (Phase 4)
3. MinerU 모델 다운로드 무거움 — Phase 0~1 시간 소요

## 진행 로그

- 2026-06-26: 계획 수립, Phase 0 착수.
- 2026-06-26: Phase 0 완료. 모노레포·venv·MinerU 3.4.0·앱 스캐폴드 구축.
  MinerU 백엔드명이 명세(`vlm-mlx-engine`)와 달라 3.4.0(`hybrid-engine`)에 맞춤.
- 2026-06-26: Phase 1 코드 작성(파이프라인 4모듈). 실제 출력 캘리브레이션은
  사용자 테스트 PDF 확보 후 진행 예정(§14-2). MinerU 첫 실행 시 VLM 모델 다운로드 필요.
- 2026-06-26: Phase 2 완료(합성 샘플). KaTeX 수식·DOMPurify 표·폴백(§7) 정상.
- 2026-06-26: MinerU 3.4.0 hybrid-engine 으로 Carhart 2012 추출(MLX 가속, 26p).
  실출력 캘리브레이션 완료 → 어댑터 확정(content_list 단일소스, 1000정규화 bbox,
  top-left 원점). Phase 1 실논문 검증 통과(140블록, bbox누락0).
- 2026-06-26: 실데이터 개선 — 인라인 수식 렌더(RichText), 넓은수식 가로스크롤,
  텍스트 이스케이프 해제. Carhart 논문에서 4-팩터 모델식·회귀표·인라인수식 모두
  정상 렌더 시각 검증. **Phase 1·2 완료.**
- 2026-06-26: 3편 다중 검증 완료 — Carhart(26p,수식8/표6), Dong(43p,수식36/표5),
  Sautner(50p,수식10/표21). 셋 다 bbox누락0·빈블록0. 서로 다른 레이아웃 일반화 확인.
  Dong 논문에서 본문 인라인 HTML(<sup>) 노출 발견 → RichText 가 sanitize 후 렌더하도록 보강.
  알려진 추출 한계: 일부 수식 마이너스 누락("t−1"→"t 1") — MinerU 한계, 후처리 안 함.
  소소한 UX 갭: 라이브러리가 새 문서 자동 갱신 안 함(앱 시작 시 1회 로드) → 차후 새로고침/감시.
- 2026-06-26: Phase 3 완료. 타이포 설정 패널·폰트 커스터마이징·문서별 영속화 구현.
  다크 테마 적용 시 본문 영역 배경 누락 버그 수정(reader-scroll에 bg/fg 명시).
  실논문에서 즉시 반영 + 재실행 복원 검증. **Phase 0~3 완료.**
- 2026-06-26: GitHub 비공개 레포 생성·푸시 → github.com/ChanchanCode/galpi
- 2026-06-26: 추가 A(페이지 스트리밍)·B(로컬 번역) 구현·검증. 추출 중 논문 부분 읽기 +
  선택 번역 모두 실제 동작 확인. MinerU 청크 재로드로 추출 시간 2~3배 트레이드오프 기록.
- **다음**: Phase 4(원본 대조 Source Peek: Option+클릭 → bbox crop 팝오버, 디버그 오버레이).
  bbox는 이미 PDF포인트로 저장돼 있어 좌표 변환만 남음(top-left 원점, y뒤집기 없음).
