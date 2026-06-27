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

- [x] **Phase 4 — 원본 대조 Source Peek (§9)** ✅ 완료
  - [x] 좌표 변환식 확정(§9.3): bbox=PDF point·좌상단 원점 → **y 뒤집기 없음**,
        축별 균일 스케일 `image_px/size_pt`(=dpi/72). Phase 1 캘리브레이션 재확인.
  - [x] 디버그 오버레이(Alt+Shift+D): 페이지 PNG 위 전 블록 bbox 박스(타입별 색) + 페이지 네비
  - [x] 검사 모드: 리더 바 🔍 토글(고정) **또는** ⌥(Option) 누른 채 클릭(일시).
        커서 돋보기 + 호버 아웃라인. 블록 클릭 → bbox crop 팝오버(loupe, 최대 3× 확대,
        큰 블록은 화면 맞춤 축소, PAD 6pt 여백). Esc/바깥 클릭으로 닫힘.
  - [x] crop 렌더: 페이지 PNG를 background-image + size/position 으로 클라이언트 crop(§9.2)
  - 검증: 5개 문서 bbox 블록 1125개 전부 crop 좌표 페이지 범위 내(out-of-bounds 0).
        tsc/vite 빌드 통과. (시각 검증은 ⌥+클릭/디버그 오버레이로 사용자 확인 권장)

- [x] **Phase 5 — 키워드 형광펜 (§8)** ✅ 완료 (실앱 시각 검증)
  - [x] CSS Custom Highlight API(`Highlight`/`CSS.highlights`)로 DOM 비변형 하이라이트.
        매칭 엔진(`highlight/highlights.ts`): 텍스트 노드 순회·정규화(공백 1개)·정규식
        (whole_word=Unicode 경계, case 옵션), KaTeX 내부 제외. 한계: 텍스트 노드 가로지르는
        매칭 제외(§8 line 380 문서화).
  - [x] 선택 미니 툴바(5색 팔레트): 드래그/더블클릭 → 색 클릭 → 동일 텍스트 전부 칠.
        같은 색 재클릭=토글 해제, 다른 색=변경, 같은 텍스트 재선택=기존 규칙 갱신(중복방지 §8.4).
  - [x] 관리 패널(🖊, §8.4): 규칙 목록(텍스트·출현수·색·채움/밑줄·라벨), 클릭 점프, 삭제.
  - [x] 영속화(§10): 문서별 state.json `highlights[]` (디바운스 병합 저장, reading:update).
  - 검증: Carhart 논문에서 "factors" 선택→노랑, 문서 전체 13곳 자동 하이라이트·패널 표시 확인.
        reflow 내성은 Range 가 텍스트 노드에 묶여 구조적으로 보장(타이포 변경=순수 CSS).
        매칭 정규식 단위테스트 4/4 통과. tsc/vite 빌드 통과.

- [~] **Phase 6 — 패키징 & 배포 (§13-6)**
  - [x] electron-builder arm64 .dmg + extraResources 로 pipeline 스크립트(.py/.sh/requirements) 동봉.
        검증: release/mac-arm64/갈피.app 245MB(모델·venv 미포함), Resources/pipeline 에 7파일.
  - [x] 패키징 경로 처리: main 이 추출 엔진을 env→settings.pythonPath→기본 pyenv(~/Library/
        Application Support/PaperReader/pyenv)→dev 순으로 탐색. 스크립트는 resourcesPath/pipeline.
  - [x] 배포(무료·수동 업데이트, 사용자 선택): app:version/checkUpdate(GitHub 최신태그 비교)/
        openExternal + 설정창 "추출 엔진·업데이트" 섹션(상태·Python 직접 지정·업데이트 확인).
  - [x] 친구 셋업: pipeline/setup-mac.sh(Python3.12+venv+MinerU 기본위치 설치) + DISTRIBUTE.md
        (빌드·릴리스·설치·Gatekeeper 우회·업데이트 안내) + .github/workflows/release.yml(태그→dmg).
  - 미결: 코드 서명/공증(자동 업데이트)은 Apple Dev $99/년 필요 → 보류. 릴리스 public 전환 필요.
        실제 친구 머신 설치·추출 e2e 검증은 미수행(빌드/번들까지 검증).

- [~] **Phase 7 — 가독성 강화 묶음 (§11)** ← 사용자 선택(2026-06-27)
  - [x] **상호참조 호버 프리뷰 + 점프 (§11-7)**: render/crossrefs.ts — 그림/표/수식(\tag)/
        정리·명제(Proposition·Lemma·Theorem·Corollary·Definition·Assumption·Remark) 인덱싱.
        본문 "Figure N / Eq. (N) / Proposition N" 언급 감지(정의블록은 `(?!\()` 로 자기링크 제외)
        → RefLink: 1초 호버 프리뷰(수식=KaTeX·정리=본문·그림=썸네일+라이트박스), 클릭 이동+도착 강조.
        검증(Sautner): eq 41/42·statement 35/36 해결(부록 eq:B.8/B.9 포함), 거짓양성 0.
        한계: 복합참조 "Eqs.(B.8) and (B.9)"의 둘째항·로마숫자 표·Section 링크 미지원.
  - [ ] **참고문헌(bibliographic) 인용 프리뷰**: 별개로 보류 — reference 블록 0개 + 저자-연도식
        이라 휴리스틱 매칭 필요. (위 상호참조와 다른 문제)
  - [x] **그림·표 인라인 참조 프리뷰 + 라이트박스 (§11-5)**: render/figures.ts(캡션 선두
        번호로 figure/table 인덱싱) + RichText 가 "Figure N/Fig. N/Table N" 언급 감지 →
        FigureRef(썸네일 팝오버·라이트박스·본문 점프, document.body 포털로 opacity 회피).
        검증: Carhart 본문 그림언급 4/4 해결. 표는 캡션 비어/로마숫자라 미해결(거짓양성 0).
  - [x] **포커스 모드 (§11-9)**: focus/FocusMode.tsx — IntersectionObserver(rootMargin
        -42%) 중앙 띠 블록만 .is-focus → 나머지 opacity 0.26. 바 토글(◎)+단축키(F).
  - [x] **아웃라인 패널 + 읽기 진행률 (§11-1,3)**: 이미 구현됨(목차 사이드패널 ☰ +
        스크롤 옆 위치 눈금/진행 표시). 스티키 섹션 헤더는 미구현(잔여).
  - [x] **다크모드 수식 대비 보정 (§11-12)**: `.katex{color:var(--fg)}` 로 테마색 바인딩.
  - 검증: tsc/vite 빌드 통과. 그림참조 인덱스 실데이터 4/4. 시각 검증(팝오버·라이트박스·
        포커스 디밍·다크 수식)은 사용자 권장.
  - 잔여: 참고문헌 인용 프리뷰, 스티키 섹션 헤더, 문단 단위 인터리브 번역(③).

- [x] **추가 C — 읽기 보조(사용자 요청 2026-06-27)**: render/reading.tsx
  - [x] Bionic Reading: 단어 앞부분 굵게(길이비례). 토글(B)+설정.
  - [x] 문장 끝 강제 줄바꿈: 보수적 문장분할(소수점·약어ABBR·이니셜 제외, "다음=공백+대문자/숫자"
        일 때만 끊음 → 과분할 방지). 토글(L)+설정. 전역 settings 영속(reading).
  - 둘 다 RichText 평문 조각에만 적용, 빠른경로(단일 텍스트노드)는 OFF일 때 유지.

- [ ] **Phase 8+ — §11 잔여 기능** (문서 내 검색/split view/하이라이트 내보내기/수식 인라인 편집 …)

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
- 2026-06-26: Phase 4 완료. 원본 대조 Source Peek 구현 — 검사 모드(🔍 토글/⌥+클릭) →
  bbox crop 팝오버(loupe), Alt+Shift+D 디버그 오버레이. 좌표 변환 y뒤집기 없음 확정,
  5문서 1125개 bbox crop 전부 페이지 범위 내(OOB 0)로 정합 검증. **Phase 0~4 완료.**
- 2026-06-26: Phase 5 완료. 키워드 형광펜(CSS Custom Highlight API) — 선택 미니 툴바(5색)·
  동일텍스트 자동 하이라이트·관리 패널·문서별 영속화. 실앱에서 "factors" 13곳 일괄 칠 +
  Source Peek 크롭(원본 p.1 정확 정합) 시각 검증. **Phase 0~5 완료.**
- **다음**: Phase 6(패키징 & 라이브러리 뷰 §13-6: electron-builder .app, 경로 추상화).
- 2026-06-27: 가독성 강화 기능 검토 → 사용자가 인용·참고문헌 호버 프리뷰, 그림·표 참조
  프리뷰+라이트박스, 포커스 모드, 아웃라인+진행률, 다크모드 수식 대비를 선택.
- 2026-06-27: 단축키 중심 UX 묶음 구현(사용자 요청, Phase 7/8 일부 선반영):
  · 텍스트 검색 ⌘F (search/FindBar + search.ts, CSS Custom Highlight 별도 키 search-hit/current,
    Enter/⇧Enter 이동·대소문자 토글, 우상단 고정 바 — 본문 hover UI 없음).
  · 중앙 키맵(keys/keymap.ts, e.code 기반 데드키 회피) + 전역 영속 + 단축키 설정 창
    (keys/ShortcutsPanel.tsx, 키 녹화 재바인딩, 중복 표시).
  · 형광펜 단축키화: 선택 미니 툴바 제거 → 선택 후 키 탭=색 순환(노랑→…→보라→해제)·꾹=제거.
    선택 유지로 연속 탭 가능, 결과는 하단 중앙 알약 알림(본문 위 아님).
  · 원문 대조 단축키(기본 G): 선택/화면 중앙 블록 즉시 crop(SourcePeek 재사용).
  · 섹션 이동 막대(sections/SectionRail.tsx): 스크롤 우측 눈금·현재 섹션 강조·클릭 점프·
    현재 위치 표시, 라벨은 막대 hover 시 여백에만.
  · 사용자 프리셋 저장 + 링크/코드 공유(presets/share.ts, 타이포만 — 사용자 선택).
    클립보드 복사 / 붙여넣기 불러오기. 인코드/디코드 라운드트립(한글·이모지·래퍼 관대) 검증.
  검증: tsc/vite 빌드 통과. 실앱 시각 검증은 사용자 권장.
  **Phase 7(가독성 강화 묶음, §11)** 신설, 잔여 §11은 Phase 8+로 재배치.
  인터리브 번역(③)은 보류.
