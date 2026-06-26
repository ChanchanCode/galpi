# 논문 가독성 뷰어 (Paper Reflow Reader) — 기술 명세서

> 이 문서는 Claude Code가 앱을 단계적으로 구현할 수 있도록 작성된 개발 명세다.
> 각 섹션은 "무엇을/왜/어떻게"를 명시한다. 모르는 부분은 추측하지 말고
> **§14 열린 결정사항**에 따라 가장 단순한 선택지를 택하고 그 선택을 코드 주석에 남긴다.

---

## 1. 프로젝트 목표

원어(주로 영어) 금융·경제 논문 PDF는 2단 조판, 작은 글씨, 빽빽한 줄간격, 수식·회귀표 때문에 가독성이 나쁘다.
이 앱은 PDF에서 텍스트·수식·표를 **고품질로 추출**한 뒤, 사용자가 타이포그래피를 자유롭게 조정하며 읽을 수 있는
**리플로우(reflow) 뷰어**를 제공한다.

### 1.1 핵심 기능 (필수)

1. **리플로우 렌더링**: 고정 레이아웃 PDF를 텍스트 흐름 기반 HTML로 재구성.
2. **타이포그래피 조정**: 줄간격, 문단 간격, 좌우 여백(본문 폭), 글꼴, 글자 크기, 자간, 정렬, 테마(라이트/세피아/다크).
3. **수식**: LaTeX로 추출 → KaTeX 렌더. **LaTeX 정확도가 최우선 요구사항.**
4. **표**: HTML 표로 렌더, 깨진 경우 원본 이미지로 폴백.
5. **키워드 형광펜**: 사용자가 선택한 텍스트에 형광펜 색을 지정하면, 문서 전체에서 **같은 텍스트가 전부 자동으로** 같은 색 밑줄/하이라이트 처리된다. 규칙은 영구 저장된다.
6. **원본 대조 (Source Peek)**: 사용자가 의아한 부분에서 **단축키 + 클릭**하면, 그 요소가 추출된 **원본 PDF 페이지 영역(crop)** 을 즉시 팝오버로 보여준다. (대조를 강제하지 않고, 의심날 때만 슬쩍 확인하고 넘어가는 UX)

### 1.2 제약

- **플랫폼: macOS 전용** (Apple Silicon 우선). 다른 OS는 비목표.
- 추출은 **느려도 된다. 품질 최우선.** 배치/오프라인 처리 허용.
- 처리는 가능한 한 **로컬·오프라인** (미공개 논문 보안).

### 1.3 비목표 (이번 범위 아님)

- PDF 원본 편집/주석을 PDF 파일에 되쓰기.
- 클라우드 동기화, 멀티유저, 모바일.
- 영어 외 다국어 OCR 최적화(차후).

---

## 2. 전체 아키텍처

두 단계를 **명확히 분리**한다. 1단계 산출물(중간 포맷)이 2단계의 유일한 입력이다.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  1단계: 추출 파이프라인 (Python)  │        │  2단계: 리플로우 뷰어 (Electron+React) │
│                             │  JSON   │                                  │
│  PDF ──> MinerU ──> 구조화    │ ─────> │  중간 포맷 로드 ──> reflow 렌더       │
│       ──> 페이지 래스터화(PNG)  │  +PNG  │  타이포 조정 / 수식 / 표 / 하이라이트  │
│       ──> 중간 포맷(JSON)     │        │  / 원본 대조(crop popover)          │
└─────────────────────────────┘        └──────────────────────────────────┘
```

분리하는 이유: 추출은 무겁고 느린 Python ML 작업이고, 뷰어는 가벼운 인터랙티브 UI다.
중간 포맷이 계약(contract) 역할을 하므로 추출 엔진을 나중에 교체(MinerU→Mathpix 등)해도 뷰어는 그대로다.

---

## 3. 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 추출 엔진 | **MinerU** (`pip install "mineru[all]"`) | Apple Silicon에서 MLX 백엔드 가속. LaTeX 수식 + HTML 표 출력. |
| 페이지 래스터화 | **PyMuPDF (fitz)** | 페이지를 고DPI PNG로. crop 좌표 계산에도 사용. |
| 추출 오케스트레이션 | Python 3.11+ CLI 스크립트 | 단순 CLI. 입력 PDF → 출력 폴더. |
| 데스크톱 셸 | **Electron** | macOS `.app` 패키징. |
| UI | **React + TypeScript + Vite** | |
| 수식 렌더 | **KaTeX** | 빠르고 SSR 가능. 실패 시 MathJax 폴백 고려(§7). |
| 상태관리 | **Zustand** | 가벼움. 타이포 설정·하이라이트 규칙 보관. |
| 스타일 | CSS 변수 + (선택)Tailwind | 모든 타이포 값은 CSS 변수로 노출(§6). |
| 하이라이트 | **CSS Custom Highlight API** | DOM 변형 없이 범위 하이라이트. 폴백은 `<mark>` 래핑(§8). |
| 영구 저장 | 사이드카 JSON 파일 | 문서별 `.reader.json` (§10). |

> Claude Code 메모: MinerU·KaTeX·Electron·Vite의 **현재 최신 안정 버전**을 설치 시점에 확인할 것.
> 버전은 이 문서에 하드코딩하지 않는다.

---

## 4. 1단계: 추출 파이프라인

### 4.1 입력/출력

- 입력: 단일 PDF 경로.
- 출력: 문서별 작업 폴더 `~/Library/Application Support/PaperReader/docs/<doc_id>/`
  - `document.json` — 중간 포맷 (§5)
  - `pages/page-<n>.png` — 페이지별 고DPI 래스터 이미지 (1-indexed)
  - `assets/` — 추출된 그림/수식/표 crop 이미지 (필요 시)
  - `source.pdf` — 원본 PDF 사본(대조용)

### 4.2 처리 순서

1. **MinerU 실행** (Apple Silicon이면 MLX 백엔드, 아니면 pipeline):
   ```bash
   mineru -p <input.pdf> -o <workdir> -b vlm-mlx-engine   # Apple Silicon
   # 가속 불가 환경: mineru -p <input.pdf> -o <workdir> -b pipeline
   ```
   - MinerU의 `content_list.json`(또는 `*_middle.json`)에는 블록별 `type`, `text`/`latex`/`html`, `page_idx`, `bbox`가 들어 있다. 이를 파싱한다.
2. **페이지 래스터화** (PyMuPDF): 각 페이지를 **목표 DPI(기본 200, 설정 가능)** 로 PNG 저장.
   - 이때 페이지별 **scale 정보**(PDF point → image pixel 변환에 필요한 배율과 페이지 크기)를 기록한다(§9 좌표계).
3. **중간 포맷 빌드**: MinerU 블록들을 §5 스키마로 정규화.
   - 읽기 순서 보존 (MinerU가 제공하는 순서 사용).
   - 하이픈으로 줄 끝에서 잘린 단어 병합 (`exam-\nple` → `example`). 단, 진짜 하이픈 단어(`cost-benefit`)는 보존하는 휴리스틱: 줄바꿈으로 분리된 `-` + 소문자 연결만 병합.
   - 문단 경계 정규화.
4. **검증 로그**: 수식/표 개수, bbox 누락 블록 수, 빈 텍스트 블록 수를 출력해 추출 품질을 가늠.

### 4.3 품질 옵션

- 시간 무관·품질 우선이 기본. MinerU의 고정밀 옵션(`--effort high` 류, 버전별 플래그 확인)을 사용.
- (선택, 차후) 수식 교차검증: 수식 crop 이미지를 Mathpix 등 외부 OCR로 보내 LaTeX를 비교, 불일치 시 `needs_review: true` 플래그. **MVP에서는 생략하고 플래그 자리만 남겨둔다.**

---

## 5. 중간 포맷 (document.json) 스키마

뷰어와 파이프라인 사이의 **계약**. 변경 시 양쪽 동시 수정.

```jsonc
{
  "doc_id": "string",                 // 폴더명과 동일
  "title": "string|null",
  "source_pdf": "source.pdf",
  "page_count": 12,
  "pages": [
    {
      "index": 1,                     // 1-indexed
      "image": "pages/page-1.png",
      "width_pt": 612.0,              // PDF 포인트 단위 페이지 크기
      "height_pt": 792.0,
      "image_width_px": 1700,         // 래스터 이미지 픽셀 크기
      "image_height_px": 2200,
      "dpi": 200
    }
  ],
  "blocks": [
    {
      "id": "b0001",                  // 문서 내 고유, 읽기 순서대로
      "type": "heading|paragraph|formula|table|figure|caption|list|footnote|reference",
      "page": 1,                      // 이 블록이 위치한 원본 페이지(스팬 시 시작 페이지)
      "bbox": [x0, y0, x1, y1],       // 원본 좌표(§9에서 좌표계 정의). null 가능
      "level": 2,                     // heading일 때만: 1~6
      "text": "string",               // paragraph/heading/caption/list 등
      "latex": "string",              // type=formula 일 때 (필수)
      "display": true,                // formula: true=block, false=inline
      "html": "string",               // type=table 일 때 (MinerU HTML)
      "image": "assets/xxx.png",      // figure 또는 표/수식 폴백 이미지
      "needs_review": false           // 차후 교차검증용
    }
  ]
}
```

규칙:
- 모든 블록은 가능한 한 `page`와 `bbox`를 가진다 (원본 대조 기능의 핵심).
- `bbox`가 없는 블록은 원본 대조에서 "페이지 전체"로 폴백.
- 인라인 수식은 별도 block으로 분리하기 어려우면 paragraph `text` 안에 `$...$` 로 인라인 표기하고, 별도 `inline_formulas` 매핑을 두는 방식도 허용(§14 결정).

---

## 6. 2단계: 리플로우 렌더링 & 타이포그래피

### 6.1 렌더 규칙

- `blocks`를 순서대로 렌더한다.
  - `heading` → `<h1..h6>` (level)
  - `paragraph` → `<p>`
  - `formula(display)` → KaTeX block, `formula(inline)` → KaTeX inline
  - `table` → `html`을 안전하게 sanitize 후 `<table>`로 삽입 (DOMPurify 사용)
  - `figure` → `<img>` (asset)
  - `caption`/`footnote`/`reference` → 적절한 스타일 클래스
- 모든 블록 요소에 `data-block-id`, `data-page`, `data-bbox` 속성을 심는다 (원본 대조·하이라이트에 사용).

### 6.2 타이포그래피 컨트롤 (CSS 변수로 노출)

설정 패널(사이드바 또는 상단 바)에서 실시간 조절. 모두 CSS 변수에 바인딩.

| 설정 | CSS 변수 | 범위/예시 |
|---|---|---|
| 본문 폭(좌우 여백) | `--content-max-width` | 560–960px 슬라이더 |
| 줄간격 | `--line-height` | 1.3–2.4 |
| 문단 간격 | `--paragraph-spacing` | 0.4–2.0em |
| 글자 크기 | `--font-size` | 14–24px |
| 자간 | `--letter-spacing` | -0.02–0.08em |
| 글꼴(본문) | `--font-family` | §6.3 |
| 글꼴(수식 스케일) | `--math-scale` | 0.9–1.3 |
| 정렬 | `--text-align` | left / justify |
| 테마 | data-theme 속성 | light / sepia / dark |
| 페이지 패딩 | `--page-padding` | 상하/좌우 여백 |

- 설정은 **문서별로 저장**되며, "전역 기본값"으로도 저장 가능(새 문서에 적용).
- 프리셋 제공: "기본", "집중(넓은 줄간격·좁은 폭)", "고대비".

### 6.3 글꼴 커스터마이징 (요청 기능)

- 내장 폰트 번들: 본문용 세리프(예: 가독성 좋은 serif), 산세리프, 그리고 **난독증 친화 폰트(OpenDyslexic 등)** 옵션.
- 본문/제목/수식 폰트를 각각 지정 가능.
- 사용자가 로컬 `.ttf/.otf` 파일을 불러와 추가할 수 있는 "폰트 추가" 기능(파일 선택 → CSS `@font-face` 동적 등록).
- 폰트 미리보기(설정 패널에서 샘플 문장).

---

## 7. 수식 렌더링

- 기본: **KaTeX**로 `latex` 렌더. block/inline은 `display` 플래그로 결정.
- KaTeX 파싱 실패(throwOnError=false로 잡음) 시:
  1. 빨간색이 아닌 **눈에 띄지 않는 경고 표시**(작은 점 아이콘)와 함께 원시 LaTeX를 코드로 표시.
  2. 해당 블록은 자동으로 `needs_review` 취급 → 원본 대조(§9)로 바로 확인 가능하게.
- (선택) MathJax 폴백 토글: KaTeX가 못 그리는 일부 매크로를 MathJax로 재시도.
- **LaTeX 정확도가 최우선**이므로, 모든 수식 블록은 원본 대조(Source Peek)의 1순위 대상이다. 수식 위에 호버하면 "원본 보기" 힌트가 살짝 뜬다.

---

## 8. 키워드 형광펜 (자동 동일텍스트 하이라이트)

### 8.1 동작

1. 사용자가 본문에서 텍스트를 드래그 선택.
2. 떠오르는 미니 툴바에서 형광펜 색을 고른다(여러 색 팔레트). 선택적으로 라벨/메모 입력.
3. 그 즉시 문서 전체에서 **같은 텍스트의 모든 출현**이 같은 색으로 하이라이트된다.
4. 규칙은 영구 저장(§10). 타이포 설정을 바꿔 화면이 reflow돼도 하이라이트는 텍스트에 묶여 유지된다.

### 8.2 규칙 데이터 모델

```jsonc
"highlights": [
  {
    "id": "h001",
    "text": "robust standard errors",   // 정규화된 매칭 문자열
    "color": "yellow",                   // 팔레트 키
    "style": "underline|fill",           // 밑줄 또는 채움
    "case_sensitive": false,
    "whole_word": true,                  // 단어 경계 매칭
    "label": "string|null",
    "note": "string|null",
    "created_at": "iso8601"
  }
]
```

### 8.3 구현: CSS Custom Highlight API 우선

- DOM을 변형하지 않고 `Highlight`/`CSS.highlights`로 범위를 칠한다. 색마다 `::highlight(color-key)` 규칙 등록.
- 매칭 알고리즘:
  - 각 블록의 텍스트 노드를 순회하며, 활성 규칙들로 `Range`를 만든다.
  - 정규화: 연속 공백을 단일 공백으로, 옵션에 따라 대소문자/단어경계 적용.
  - 인라인 수식 등으로 텍스트가 끊긴 경계는 **블록 내 연속 텍스트 런 단위**로만 매칭(스팬 매칭은 MVP 제외, 한계로 문서화).
  - 성능: 규칙 변경 시에만 재계산, `requestIdleCallback`/디바운스 사용. 큰 문서는 화면에 보이는 블록 우선(IntersectionObserver) 처리.
- 폴백(구버전 WebView): 텍스트 노드를 `<mark data-hl-id>`로 래핑. 단, reflow/해제 시 정확히 원복되도록 래핑은 렌더 파이프라인의 마지막 패스에서만.

### 8.4 관리 UI

- 사이드 패널 "하이라이트" 탭: 규칙 목록(색·텍스트·개수·라벨), 클릭 시 첫 출현으로 스크롤, 색 변경/삭제.
- 같은 텍스트 재선택 시 기존 규칙 갱신(중복 생성 방지).

---

## 9. 원본 대조 (Source Peek) — 핵심 UX

### 9.1 동작

- 사용자가 **modifier 키(기본: Option/Alt)** 를 누르면 "검사 모드" 진입: 커서가 돋보기로 바뀌고, 블록에 호버하면 미세한 아웃라인 표시.
- 그 상태에서 블록을 **클릭**하면, 그 블록의 `page` + `bbox`에 해당하는 **원본 페이지 PNG의 잘라낸 영역**을 확대해 **팝오버(loupe)** 로 띄운다.
- `Esc`/바깥 클릭/키 떼기로 닫힘. 흐름을 끊지 않도록 가볍고 빠르게.
- 단축키 단독(클릭 없이)으로도, 현재 화면 중앙 블록의 원본을 토글하는 보조 동작 제공(선택).

### 9.2 crop 방법 (권장: 사전 래스터 + 클라이언트 crop)

- 추출 때 만든 `pages/page-<n>.png`를 사용. 클릭 시 캔버스/`object-fit` + `clip`으로 bbox 영역만 잘라 2~3배 확대 표시.
- 여백을 살짝 포함(bbox에 padding ~8px 상당)해 맥락이 보이게.
- 빠르고 원본과 100% 동일. (대안: PDF.js 실시간 렌더는 무겁고 불필요 → 채택 안 함.)

### 9.3 좌표계 변환 (반드시 캘리브레이션)

- PDF 좌표 원점은 보통 **좌하단(y 위로 증가)**, 이미지 픽셀 원점은 **좌상단(y 아래로 증가)**.
- MinerU bbox의 좌표 기준(PDF point인지, 특정 스케일 이미지 기준인지)은 **버전에 따라 다를 수 있으므로 가정하지 말고 캘리브레이션**한다:
  1. 변환식 일반형:
     ```
     scale_x = image_width_px  / width_pt
     scale_y = image_height_px / height_pt
     # PDF가 좌하단 기준일 때:
     px_x0 = bbox.x0 * scale_x
     px_y0 = (height_pt - bbox.y1) * scale_y   # y 뒤집기
     px_x1 = bbox.x1 * scale_x
     px_y1 = (height_pt - bbox.y0) * scale_y
     ```
  2. **디버그 오버레이 모드**를 만든다: 페이지 이미지 위에 모든 블록 bbox를 반투명 박스로 그려, 좌표가 맞는지 눈으로 검증. 어긋나면 위 변환(특히 y 뒤집기 유무)을 조정.
  3. MinerU가 이미 이미지 기준 좌표를 준다면 y 뒤집기를 빼는 식으로 분기. 이 결정은 캘리브레이션 결과에 따라 코드 주석으로 명시.

---

## 10. 영구 저장

- 문서별 사이드카: 작업 폴더의 `state.json`
  ```jsonc
  {
    "typography": { /* §6.2 값 */ },
    "highlights": [ /* §8.2 */ ],
    "formula_edits": { "b0123": "corrected latex" },  // 수동 수정(선택 기능)
    "last_scroll_block": "b0042",
    "reading_progress": 0.37
  }
  ```
- 전역 설정(기본 타이포·기본 폰트·단축키 매핑): `~/Library/Application Support/PaperReader/settings.json`.
- 저장은 디바운스하여 자동. 외부 DB 불필요(파일 기반으로 충분, 백업·이동 쉬움).

---

## 11. 추가 제안 기능 (있으면 편리)

MVP 이후 우선순위 순. Claude Code는 MVP(§13) 먼저 완성 후 진행.

1. **목차/아웃라인 패널**: heading 기반 네비게이션, 클릭 점프, 현재 위치 하이라이트.
2. **문서 내 검색**: 텍스트 검색 + 일치 항목 간 이동. 검색어를 임시 하이라이트로 표시.
3. **읽기 위치 기억**: 문서를 다시 열면 마지막 위치로 복원.
4. **원본/리플로우 나란히 보기(split view) 토글**: 왼쪽 원본 PDF 페이지, 오른쪽 리플로우. 스크롤 동기화(가능 범위에서).
5. **그림/표 확대(lightbox)**: 클릭 시 크게.
6. **하이라이트/메모 내보내기**: 규칙·메모를 Markdown으로 내보내 노트 앱에 붙여넣기.
7. **참고문헌·인용 처리**: `reference` 블록 정리, 본문 인용 → 참고문헌 점프(가능하면).
8. **키보드 중심 UX**: 단축키로 스크롤/검색/하이라이트색 전환/원본대조/설정 토글. 단축키 도움말 오버레이(`?`).
9. **포커스 모드**: 현재 문단만 또렷하게, 나머지 디밍.
10. **수식 수동 수정 인라인 편집기**: 원본 대조 팝오버 안에서 LaTeX를 바로 고치고 재렌더(틀린 추출 구제용). `formula_edits`에 저장.
11. **세션 복수 문서 탭/라이브러리 뷰**: 추출한 문서 목록·검색.
12. **다크모드 수식 가독성**: KaTeX 색을 테마에 맞게.
13. **추출 진행 표시 + 재추출 버튼**: 품질 불만 시 다른 백엔드/DPI로 재시도.

---

## 12. 디렉터리 구조 (제안)

```
paper-reader/
├─ pipeline/                      # 1단계 (Python)
│  ├─ extract.py                  # CLI 엔트리: PDF -> workdir
│  ├─ mineru_adapter.py           # MinerU 실행 & 출력 파싱
│  ├─ rasterize.py                # PyMuPDF 페이지 -> PNG + scale 기록
│  ├─ build_document.py           # 중간 포맷(document.json) 빌드
│  └─ requirements.txt
├─ app/                           # 2단계 (Electron + React)
│  ├─ electron/                   # main process, 파일 IO, 메뉴, 단축키
│  ├─ src/
│  │  ├─ render/                  # 블록 렌더러(문단/수식/표/그림)
│  │  ├─ typography/              # 설정 패널 + CSS 변수 바인딩
│  │  ├─ highlight/               # CSS Custom Highlight 로직
│  │  ├─ sourcepeek/              # 검사 모드 + crop 팝오버 + 좌표변환
│  │  ├─ store/                   # zustand 상태 + 영속화
│  │  ├─ fonts/                   # 번들 폰트 + 사용자 폰트 등록
│  │  └─ ui/                      # 사이드바, 툴바, 라이트박스 등
│  ├─ index.html
│  └─ package.json
└─ PAPER_READER_SPEC.md           # (이 문서)
```

---

## 13. MVP 정의 & 빌드 순서

각 단계는 끝에 **검증 기준**을 만족해야 다음으로.

1. **추출 파이프라인 골격**
   - MinerU로 논문 1편 → `document.json` + 페이지 PNG 생성.
   - 검증: 수식이 `latex`로, 표가 `html`로, 각 블록에 `page`/`bbox`가 들어감.
2. **기본 리플로우 렌더**
   - `document.json`을 읽어 문단/제목/수식(KaTeX)/표/그림을 순서대로 렌더.
   - 검증: 한 편이 위→아래 자연스러운 단일 컬럼으로 읽힘. 수식이 그려짐.
3. **타이포그래피 조정 + 폰트 커스터마이징**
   - 줄간격·여백·폰트·크기·테마 실시간 반영, 문서별 저장.
   - 검증: 설정 변경이 즉시 반영되고 재실행 시 복원.
4. **원본 대조(Source Peek)** + 좌표 캘리브레이션 + 디버그 오버레이.
   - 검증: Option+클릭 시 정확한 원본 영역 crop이 뜬다(디버그 오버레이로 bbox 정합 확인).
5. **키워드 형광펜**
   - 선택 → 색 지정 → 동일 텍스트 전부 하이라이트, 영구 저장, reflow 후 유지.
   - 검증: 줄간격을 바꿔도 하이라이트가 따라온다.
6. **Electron 패키징** (`.app`), 라이브러리/문서 라이브러리 뷰.
7. 이후 §11 추가 기능.

---

## 14. 열린 결정사항 (Claude Code가 단순한 쪽으로 결정 후 주석 남길 것)

1. **인라인 수식 표현**: 별도 block vs paragraph 내 `$...$` 인라인 + 매핑. → 우선 paragraph 내 인라인 표기로 단순화, 정확도 문제 시 분리.
2. **MinerU 출력 필드명·좌표 기준**: 설치된 버전의 실제 `content_list.json`을 열어 필드/좌표계를 확인하고 `mineru_adapter.py`에 맞춘다. 가정 금지.
3. **표 sanitize 정책**: DOMPurify 허용 태그 화이트리스트(table/thead/tbody/tr/td/th/colspan/rowspan만).
4. **하이라이트 스팬 매칭**: 블록 경계/인라인 수식을 가로지르는 매칭은 MVP 제외(한계 문서화).
5. **상태 저장 위치**: 작업 폴더 사이드카 우선(이동·백업 쉬움). 전역 설정만 appData.
6. **MathJax 폴백 포함 여부**: KaTeX 실패율을 본 뒤 결정. 자리만 마련.

---

## 15. 리스크 & 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| 수식 LaTeX 오추출 | 최우선 요구 위반 | 원본 대조를 수식 1순위로, KaTeX 실패 자동 플래그, (차후) Mathpix 교차검증, 수동 인라인 수정 |
| 회귀표 구조 붕괴 | 가독성 저하 | HTML 표 + 원본 이미지 폴백 토글, 표도 Source Peek 대상 |
| bbox 좌표 불일치 | 원본 대조 어긋남 | 디버그 오버레이로 캘리브레이션, 변환식 분기 |
| 2단 읽기 순서 오류 | 흐름 깨짐 | MinerU 순서 신뢰 + 이상 시 재추출 옵션 |
| 큰 문서 하이라이트 성능 | 렉 | 가시 블록 우선 처리, 디바운스, Custom Highlight API |

---

## 16. 참고 (도구 특성 요약)

- **MinerU**: 학술 논문의 복잡한 레이아웃·수식(LaTeX)·표(HTML)에 강하고, Apple Silicon에서 MLX 가속 지원. 로컬·오프라인. 표 인식은 케이스에 따라 약점이 있을 수 있어 이미지 폴백을 둔다.
- **KaTeX**: 빠른 수식 렌더, 일부 매크로 미지원 → MathJax 폴백 여지.
- **CSS Custom Highlight API**: DOM 비변형 범위 하이라이트로 reflow와 궁합이 좋음.
- **Mathpix**(선택·상용): 수식 OCR→LaTeX 정확도 최상위. 보안·예산 허용 시 교차검증용으로만 사용.

> 끝. 구현 중 막히면 §14의 원칙(가장 단순한 선택 + 주석)을 따른다.
