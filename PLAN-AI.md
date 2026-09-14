# PLAN-AI — 갈피 AI 내장 실행 계획

> 작성 2026-08-26. **다음 세션이 이 문서만 읽고 착수할 수 있도록** 쓴 인수인계 문서다.
> 이 문서의 숫자는 전부 이 기계에서 실측한 값이다. 추정에는 "추정"이라고 적었다.
> 상위 문서: [PAPER_READER_SPEC.md](PAPER_READER_SPEC.md) · [PLAN.md](PLAN.md) · 작업 이력은 [WORKLOG.md](WORKLOG.md)

시각 시안(디자인 확정본): `https://claude.ai/code/artifact/88e21aa5-55f7-4c8b-b2c3-5841e9a68484`

---

## 0. 무엇을 만드는가

갈피에 **번역·요약·키워드·질문·도표해설**을 내장한다. API 키 없이 **Gemini 구독(Antigravity)에 붙은 토큰**으로 돈다.
사용자는 본인 + 친구 1명. 각자 자기 구글 계정으로 `agy`에 로그인해 쓴다.

---

## 1. 확정된 결정

| # | 결정 | 근거 |
|---|---|---|
| D1 | **백엔드 = `agy` 사이드카** — 단, 「상주 단일 세션」이 아니라 **웜 스페어 풀**(§2.8) | 웜 TTFT 1.61초. 상주 세션은 이력 재전송으로 배치 비용이 5배 튄다 |
| D2 | **BYOK REST 경로는 폴백으로 존치** | agy가 깨져도 앱이 안 죽는다. 코드가 이미 있다 |
| D3 | **네이티브 직접호출(gemini-cli client_id) 불채택** | ① Antigravity 버킷을 못 쓸 공산이 큼(`/usage`가 노출하는 버킷이 `gemini-weekly`/`gemini-5h`/`3p-weekly`로 Antigravity 전용) ② 남의 client_id로 자기를 그 클라이언트라 식별시키는 일 |
| D4 | **전용 미니멀 에이전트 `galpi`** (`tools: [send_message]`) | **보안이 주목적** — 기본 에이전트는 `run_command`·`write_to_file` 포함 툴 57개. 논문 본문은 신뢰할 수 없는 입력이다. 토큰 −71%는 부수 효과 |
| D5 | **모델 기본 `gemini-3.7-flash-low`** | `-medium`은 thinking에 1,767토큰을 쓰는데 품질 차이가 "t기 오차항" vs "t 시점 오차항" 수준. 3.5배 값어치 없음. 문서별 "고품질" 옵션으로 medium 제공 |
| D6 | **원본 페이지는 SVG 벡터로 추출** (`page.get_svg_image(text_as_path=True)`) | 무한 확대 + `fill` CSS 한 줄로 테마 적용. gzip 25KB/쪽 (PNG 242KB) |
| D7 | **스캔본은 예외** — 래스터 유지하되 `dpi=200` 고정 해제 | 라이브러리 5편 중 MacKinlay 1996만 스캔본(텍스트 0자·폰트 0종). 원본 4300×6000인데 1434×2000으로 굽고 있었다 |
| D8 | **기본 보기 A = 리플로우 ‖ 번역**, 블록 행 정렬(여백 감수) | 사용자 확정 |
| D9 | **B = 원본 ‖ 번역**, `⌥O`로 왼쪽만 교체. 번역 패널은 자리를 지킨다 | 사용자 확정 |
| D10 | **C(블록 아래 끼워넣기) 폐기** | 사용자 확정 |
| D11 | **B는 캔버스** — 연속 스크롤 + 패닝 + 핀치 줌 | 폭에 갇히지 않게 |
| D12 | **줌은 레이아웃(`zoom`), transform 아님** | `transform:scale()` + `will-change`는 비트맵을 늘려 전부 뭉갠다. 제스처 중만 transform, 140ms 뒤 `zoom`으로 확정 |
| D13 | **문장 단위 호버 연결** — 번역을 문장 정렬로 받는다 | 왕복 검증 통과. §5 |
| D14 | **번역 캐시 키 = 텍스트 해시** (블록 id 아님) | 재추출해도 살아남아야 한다 |
| D15 | **타이포 패널 통합, 값은 분리** | 글꼴만 연동 기본, 크기·줄간격·자간은 원문/번역 독립. §7 |
| D16 | **관련 논문 추천은 범위 밖** | 외부 API(OpenAlex/S2) 필요. 별건 |
| D17 | **벡터 판정 = SVG 에 `<image>` 0개** (쪽 단위) | 초안 식은 5편 중 3편 오분류. §2.10 |
| D18 | **래스터 상한 3400px / 400dpi, 스캔은 JPEG q85** | 460dpi 는 화면에서 확인 못 할 화질에 디스크 3배. §2.10 |
| D19 | **번역 컬럼은 `.reader-content` 밖** | 안에 넣으면 형광펜·메모·검색·내보내기 10개 모듈이 한국어를 본문으로 먹는다. §2.11 |
| D20 | **행 정렬은 JS 측정** (그리드 래퍼 아님) | 래퍼를 넣으면 `:scope > [data-block-id]` 가정이 `FocusMode.tsx:78`·`styles.css:798`·`focus-runtime.js:85` 세 곳에서 죽는다 |
| D21 | **문장 경계의 주인은 모델** (`data-g` index) | `reading.tsx:50` 은 읽기 보조(바이오닉·문장나눔) 전용으로 남긴다. 두 경계를 통합하지 않는다 |
| D22 | **마스킹 정규식은 파이프라인·RichText 와 한 패턴** `(?<!\\)\$.+?(?<!\\)\$` | 안 맞추면 `\$17.00` 같은 실데이터에서 산문을 수식으로 마스킹해 앵커가 통째로 밀린다 |
| D23 | **캐시 키에 마스킹 규칙 버전(`MASK_RULES_VERSION`)을 넣는다** | 정규식을 고치면 같은 원문이라도 모델이 보는 텍스트가 달라진다 |
| D40 | **자동 맞춤은 사용자가 안 만졌을 때만.** 캔버스 상태는 App 이 소유 | 버튼 하나 눌렀다고 맞춰 둔 배율이 날아가면 안 된다. `touched` 플래그로 `fit()` 을 막고, 원본 모드 캔버스를 App 으로 올려 보기 전환 때 재마운트돼도 배율·위치가 산다. 이동은 DOM 직접 쓰기라 렌더마다 다시 붙인다 |
| D37 | **보기 A 의 번역은 원문과 같은 크기·줄간격** | 영문 18px 옆 한글 14px 은 밸런스가 깨지고 문서마다 손으로 맞출 수 없다. 글꼴·자간은 번역 축 유지. 원본 모드는 지면 옆이라 사정이 달라 전용 크기를 남긴다 |
| D38 | **행 정렬은 원문이 간격을 내준다** — 카드를 밀지 않는다 | 카드를 밀면 정렬이 어긋나고 결국 겹친다. 원문 블록에 `padding-bottom` 을 넣어 그 행을 벌린다(래퍼가 아니라 padding 이라 D20 유지). 실측 정렬 오차 0.5px·겹침 0 |
| D39 | **표·수식·그림은 두 컬럼 전체 기준으로 가운데** | 본문 컬럼만 기준이면 번역탭 위로 넘쳐 한국어를 덮는다. 행 계산도 카드 없는 블록까지 포함해 자리를 비운다 |
| D31 | **번역 컬럼도 LaTeX 을 렌더한다** (`TrText`) | 번역문에 `$...$` 가 글자 그대로 살아 있어 `$\alpha_{s}$` 가 노출됐다. 각주·상호참조는 원문 쪽에만 있으므로 RichText 가 아니라 수식만 그리는 전용 렌더러를 쓴다 |
| D32 | **상단바에서 목차·주석 버튼 제거.** 목차는 **제목 텍스트 클릭** | 아이콘 9개는 무슨 기능인지 안 보인다. 주석은 `I` 단축키로 남는다. 사용자 확정 |
| D33 | **보기 전환은 번역과 독립** — `T` 없이도 원본 모드로 간다 | 번역 없이 지면만 보고 싶을 때가 있다. 사용자 확정 |
| D34 | **번역 팝업은 '처음 번역할 때'만.** 재번역은 카드 우클릭 | 상시 코너 위젯을 없앴다. 팝업은 백엔드·모델(빠름/정확)·예상 소모만 보여 준다. 사용자 확정 |
| D35 | **가로 이동은 state 가 아니라 DOM 직접 쓰기** (rAF 합침) | state 로 두면 프레임마다 카드 수백 개가 리렌더돼 가로만 버벅인다(세로는 네이티브 스크롤이라 멀쩡했다). 실측 115fps |
| D36 | **번역 컬럼을 여는 순간 맞춤 배율** | 본문 폭은 옵션 값을 지키므로(고정) 컬럼이 화면 밖으로 잘린다. 배율로 줄이는 게 답 |
| D27 | **보기 A 에도 팬/줌 캔버스** — D11 을 A 로 확장 | 사용자 확정(2026-08-26). §7.1 의 "캔버스 안 붙인다" 를 뒤집었다. 두 보기가 `useCanvas` 훅 하나를 공유한다 |
| D28 | **가로 이동은 네이티브 스크롤이 아니라 transform** — 캔버스 폭의 60% 까지 화면 밖 허용 | 가운데 고정이면 확대 상태에서 지면 가장자리를 못 본다. 사용자 확정 |
| D29 | **폭 손잡이는 번역탭 오른쪽 끝**, 오른쪽으로 끌면 넓어진다 | 처음엔 두 패널 사이에 뒀다가 사용자 판단으로 되돌림 — 이쪽이 직관적 |
| D30 | **읽기 보조 '문장 줄바꿈'은 번역 컬럼에도 걸린다** | 번역 문장은 이미 `.tr-s` 로 쪼개져 있어 `display:block` 한 줄이면 된다. 사용자 확정 |
| D25 | **출력 견적 계수는 기능별** + 출력 EWMA 분리. 원장에 `EST_RULES_VERSION` | 문장 정렬이 영문을 되돌려줘 출력이 2.41배. §2.13 |
| D26 | **잘린 JSON 응답은 온전한 객체만 건진다** | 통째로 버리면 그 배치 블록이 전부 날아간다(실측 26배치 중 1개 → 5블록 손실) |
| D24 | **파이프라인 텍스트 수정(footer 제거·list 개행·캡션 복구)은 P2 밖** | 블록 id 가 읽기 순서라 하나만 늘어도 뒤가 전부 밀려 기존 `state.json` 주석이 깨진다. 별도 마이그레이션 건 |

---

## 2. 실측 데이터 — 계획이 서 있는 숫자

전부 2026-08-26에 이 기계에서 직접 실행해 얻었다.

### 2.1 agy 동작

| 항목 | 값 |
|---|---|
| 증분 스트리밍 | **있음** — `text_delta` 약 200ms 간격 |
| 콜드 기동 → `init` | 5.1~5.4초 (프로세스 기동은 0.26초, 나머지는 `loadCodeAssist` 네트워크) |
| `init` → 첫 델타 | 1.4~1.6초 = **웜 세션 실질 TTFT** |
| 웜 턴 지연 | 0.8~1.7초 |
| 기본 에이전트 입력 오버헤드 | 13,734~13,990 토큰 — **매 턴 재청구된다** |
| 미니멀 에이전트(`send_message`만) | **4,010 토큰** (−71%) |
| `finish` 툴을 넣으면 | 턴당 모델 호출 2배. **넣지 마라** |
| 프롬프트 캐시 | 9턴 중 1회만 히트. **기대하고 설계하지 마라** |
| 동시 실행 | 5개 병렬 OK, 같은 HOME, db 충돌 없음 |
| 이미지 판독 | `--add-dir` 파일 경로 경유 가능. 1434×2000 PNG = 입력 43,699 토큰 → **리사이즈 필수** |
| `/usage` 조회 | **0 토큰**, 5.3초, 대화 안 남김 |
| 호출당 디스크 | conversation SQLite ~350KB. 지속 세션이면 세션당 1개 |

### 2.2 한도 소모 = 토큰 **비용** 비례 (요청 수 아님)

크기가 다른 두 턴의 `remaining_fraction` 변화로 풀었다.

```
turn A: in=13,990  out=323  → Δ5h = 0.000585079,  Δweekly = 0.000097572
turn B: in=13,734  out=1    → Δ5h = 0.000454426
```

| 계수 | 값 |
|---|---|
| 입력 | **3.306e-8** / 토큰 |
| 출력 | **3.795e-7** / 토큰 (**입력의 11.5배**) |
| 5시간 버킷 용량 | 입력환산 30.2M / 출력환산 2.64M 토큰 |
| 주간 버킷 | 5시간의 **6.0배** |

> **thinking 토큰은 출력으로 계산된다.** `-medium`이 비싼 이유가 이것이다.

### 2.3 한국어 출력

| 항목 | 값 |
|---|---|
| 한국어 밀도 | 1.71~1.97 chars/token |
| 영문 대비 글자수 | **0.49~0.57배** |
| 영문 대비 **토큰수** | **1.13~1.17배** |

> 조사 중간에 나온 "출력 = 입력 × 1.5~2.0" 추정은 **과대였다.** 위 값을 쓸 것.

### 2.4 견적 계수 (블록 타입별 chars/token)

| 문단 | 제목 | 각주 | 목록 | 수식(latex) | 표(html) |
|---|---|---|---|---|---|
| 4.5 | 4.1 | 3.8 | 3.2 | **2.1** | **1.8** |

단일 계수 `chars÷4`를 쓰면 수식·표 많은 논문에서 2배 이상 과소견적한다.
MinerU 번들 토크나이저(Qwen2-VL)로 측정했으므로 절대값은 Gemini와 ±10% 차이 가능.
**원장의 `est_in` vs `usage.in`으로 EWMA 보정할 것.**

문서 전체 입력 토큰 실측: 21.7k / 24.1k / 28.3k / 42.3k / 44.6k (페이지당 426~1,143)

### 2.5 논문 1편 전문 번역 비용

| 구성 | 42쪽 환산 Δ5h |
|---|---|
| `send_message`만 + **low** + 배치 | **1.84 %** |
| `send_message`만 + low + 쪽당 1회 | 2.31 % |
| `send_message`만 + medium | 7.98 % |
| `finish` 포함 + medium | 8.77 % |

→ **논문 1편 ≈ 1.8~2.3%. 5시간당 43~54편.**
문장 정렬(§5)을 켜면 영문을 되돌려받아 **약 1.7배** → 42쪽 3.9%, 5시간당 25편. 그래도 충분.
선택 번역 1회(문단 하나) = 0.027% → 5시간당 3,690회. 사실상 공짜.

### 2.6 로그인 감지 — stdin 종류로 갈린다

| stdin | 결과 |
|---|---|
| **파이프** (Electron 기본) | **0.6초 즉시 rc=1** + stderr `Error: authentication required. Run 'agy' to log in, then retry.` |
| `/dev/null` | 60초 매달림 후 rc=1, `"error":"authentication failed or timed out"` |
| tty | 대화형 로그인 |

- 앱은 파이프로 spawn하므로 **미로그인을 즉시·명확히 감지**한다.
- 인가 코드를 stdin으로 넣을 수 없다 → **앱 내 로그인 불가**. 터미널에서 `agy` 1회 실행 필요.
  macOS는 `open -a Terminal`로 대신 열어 줄 수 있다.
- **한 번 로그인하면 계속 간다.** 키체인 토큰이 1시간 만료지만 자동 갱신되고 refresh_token은 유지된다
  (`~/.gemini/antigravity-cli/log/` 의 `token refreshed, new expiry=`).

### 2.7 agy stream-json 프로토콜 실측 (2026-08-26, P1 착수 시 재측정)

`{"event":"<이름>", "<이름>":{…}}` 형태다. **`type` 이 아니라 `event`** 이고 본문이 같은 이름의 키에 중첩된다.

| 항목 | 실측값 |
|---|---|
| 콜드 기동 → `init` | 5.86 / 6.00 / 6.16초 (3개 동시) |
| 웜 턴 TTFT(첫 `text_delta`) | **1.61초** · 70초 유휴 뒤 2.22초 |
| 델타 알갱이 | 짧은 응답은 1~2개. 문장 단위로 뭉쳐 온다 |
| 이벤트 종류 | `init` · `step_update` · `result` 뿐 |
| 턴별 usage | `step_update{step_type:"agent_response", state:"DONE"}.usage` |
| usage 필드 | `{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` |
| `result.usage` | **누적**. 턴 증분과 위 step usage 가 정확히 일치함을 확인 |
| 유휴 생존 | 70초 확인(기존 25초에서 연장) |
| 프로세스 RSS | **개당 약 165MB** (3개 493MB) |
| 깨진 stdin 줄 | `result{status:"ERROR", error:"failed to decode stream input…"}` 후 즉시 rc=1 |
| stdin 종료 | `result{status:"ERROR", error:"stream input cancelled: context canceled"}` rc=1 — 정상 종료다 |

**`init.tools` 는 57개를 그대로 나열한다 — 에이전트 제한이 안 걸린 게 아니다.**
그 필드는 CLI 레지스트리이지 에이전트 허용 목록이 아니다. 실제 입력 토큰이 3,885 (기본 에이전트 ~13,900)로
D4 의 미니멀 에이전트는 정상 작동 중이다. 이 필드를 헬스체크에 쓰면 안 된다.

### 2.8 ⚠️ 상주 세션은 대화 이력을 매 턴 재전송한다 — §2.5 견적의 전제를 바꾼다

같은 세션에서 3턴을 돌렸을 때 입력 토큰: **3,885 → 3,985 → 4,090**.
증가분이 정확히 "직전 턴의 user+assistant" 다. 즉 턴 N 의 입력 = 기본 4k + Σ(이전 턴 입출력).

짧은 문장이라 100토큰씩 늘었지만 **전문 번역 배치(턴당 입력 3k / 출력 3.5k)면 이야기가 다르다.**
7배치 문서라면 턴별 입력이 7k → 17.5k → 31k … 로 불어 총 입력이 단순합의 **약 5배**가 된다.
§2.5 의 "논문 1편 1.84%" 는 이 효과를 안 세었다.

agy 에는 대화를 비우는 입력 이벤트도 플래그도 없다(`--help` 전수 확인).
→ **설계 수정: 상주 단일 세션이 아니라 「웜 스페어 풀」.**

- 프로세스를 미리 띄워 `init` 까지 데워 둔다(5.9~6.2초, 임계 경로 밖).
- **무상태 기능(번역·요약·키워드)은 한 프로세스당 1턴만 쓰고 폐기**, 즉시 대체 프로세스를 뒤에서 데운다.
  → TTFT 1.6초를 유지하면서 이력 오버헤드 0.
- 이력이 **필요한** 기능(P5 멀티턴 질문)만 전용 세션을 붙잡고 산다.
- 메모리가 개당 165MB 이므로 기본 풀은 **웜 스페어 1 + 인플라이트 최대 2**.

### 2.9 ⚠️ agy 호출 = macOS 키체인 프롬프트 (사용자 신고 → 실측 확인)

`agy -p "/usage"` 를 한 번 부르면 `SecurityAgent` 가 뜬다(실측: 평소 5초 호출이 11.5초).
agy 는 **거의 매일 갱신**되는데 바이너리 서명이 바뀌면 키체인 ACL 이 무효화되어,
사용자가 **"항상 허용"** 을 다시 누를 때까지 **호출마다** 창이 뜬다.

이 때문에 P1 초안의 "`/usage` 5분 주기 폴링" 은 **5분마다 프롬프트**를 띄웠다. 폐기했다.

| 규칙 | 이유 |
|---|---|
| 진단 목적으로 agy 를 부르지 않는다 | 로그인 여부는 **실제 턴의 성공/auth 실패**로 판정한다(공짜) |
| `/usage` 는 사용자가 버튼을 누를 때만 | 토큰은 안 먹지만 프롬프트는 띄운다 |
| prewarm 은 로그인 확인 뒤에만 | 문서만 열고 번역을 안 쓰면 agy 를 아예 안 부른다 |
| `ai.agyOk` 를 설정에 남긴다 | 다음 실행에서 진단 호출 없이 agy 백엔드를 고를 수 있다 |

> **BYOK 폴백(D2)을 존치한 판단이 여기서 값을 했다.** agy 경로는 우리가 통제 못 하는
> 외부 바이너리의 서명 수명에 묶여 있다.

### 2.10 P2 착수 실측 — 벡터/래스터 판정과 H5 (병렬 탐색 + 직접 재현)

**PLAN 초안의 `is_vector = get_fonts()>0 or get_text()>0` 는 5편 중 3편을 오분류한다.**
OCR 텍스트 레이어가 얹힌 스캔본이 이 식에서 "벡터"로 나온다. 실제로 SVG 를 뽑아 봐야 한다.

| 문서 | 초안 식 | `<use>` | `<image>` | 판정 | 결과 |
|---|---|---|---|---|---|
| ssrn-608601 | True | 734 | 0 | **벡터** | SVG gzip 30KB/쪽 |
| ssrn-661481 | True | 1995 | 0 | **벡터** | SVG gzip 39~54KB/쪽 |
| elsevier 1-s2.0 | True | 0 | 1 | 래스터 | dpi 200→**300** |
| fama1992 | True | 339 | **1** | 래스터 | dpi 200→**372** |
| mackinlay | False | 0 | 1 | 래스터 | dpi 200→**340** |

- 확정 판정식: **`<image>` 가 0개이고 `<use>`/`<path>` 가 있으면 벡터.** `pages[].is_vector` 로 쪽 단위 기록.
- `fill` 속성이 SVG 전체에 **0개**임을 확인 → `svg{fill:var(--fg)}` 한 줄로 테마가 먹는다(D6 의 메커니즘은 옳았다).
- `viewBox="0 0 612 792"` = PDF point → 블록 bbox 를 % 로 얹으면 줌과 무관하게 따라온다.
- **id 충돌은 실재한다** — 쪽당 `id="font_1_21"` 51개. `id=` / `xlink:href="#` / `url(#` 세 곳에 쪽 접두를 붙였다(`p1_`).
- `<use data-text="2">` 로 글리프마다 원문 글자가 실려 온다. 지금은 안 쓰지만 문장 bbox 의 잠재 소스다.

**H5 상한을 원본 해상도까지 열지 않았다.** 실측: mackinlay 30쪽이 200dpi 14MB / 300dpi 25MB / 460dpi 45MB.
보기 B 는 패널 폭 ~700px 에서 최대 400% 확대를 상정하므로 긴 변 ~2800px 이면 충분하다.
→ `MAX_LONG_EDGE_PX=3400`, `MAX_DPI=400`. 그리고 **포맷을 가른다**: 벡터 쪽은 PNG, 스캔 쪽은 JPEG q85
(340dpi 기준 PNG 1.28MB → JPEG 0.83MB). 소비처는 전부 `pages[].image` 문자열을 따라가므로 안전하다(전수 확인).

> **통과 조건 수정**: "400% 확대에서 벡터가 선명" 은 벡터 2편에만 적용된다.
> 래스터 3편의 기준은 "200% 에서 기존 200dpi 판보다 확실히 낫다" 로 바꾼다.

### 2.11 P2 착수 실측 — 렌더러 구조에서 나온 확정 사실

| 항목 | 사실 |
|---|---|
| 테마 변수 | `--bg --fg --muted --rule --accent --scrollbar-thumb` (`styles.css:16-18`), 전환은 `<body data-theme>`. **`--g-fg`/`--g-bg` 는 존재하지 않는다** — §7.3 의 CSS 예시는 틀렸다 |
| 블록 DOM | `BlockRenderer.tsx:13-19` 가 `data-block-id`/`data-page`/`data-bbox` 를 **최상위 단일 요소**에 붙인다. HTML `id` 는 없다 |
| 렌더 루프 | `App.tsx:432-444`. 인덱스 정렬 불가(front-matter 합성·흡수 블록 null·각주 합성 블록) — **`block.id` 매칭만 성립** |
| 형광펜 | `highlights.ts:113` 이 TreeWalker **1개**로 훑고 `:128` 이 규칙을 순회 → O(T×R) exec, DOM 순회 1회. **§9-P4 의 "규칙별 전체 순회가 터진다" 는 틀렸다** |
| 컨테이너 | `.reader-content` 를 `document.querySelector` 로 잡는 모듈이 **10곳**. `::highlight()` CSS 는 전부 비스코프 |
| 문장 분리 | `reading.tsx:50 splitSentences` (약어 38개 사전)가 이미 있으나 **DOM 요소를 만들지 않는다**. `FocusMode.tsx:83` 이 제3의 계산을 한다 |
| 페이지 크기 | **한 문서 안에서 섞인다** (mackinlay 516×720 27쪽 + 595×792 3쪽). 보기 B 오프셋은 `pages[].height_pt` 누적이어야 한다 |
| 블록 id | 읽기 순서 인덱스(`build_document.py:97`). 앞에서 하나만 늘어도 뒤가 전부 밀린다 |

### 2.15 ⚠️ `width: max-content` 가 무대를 8,385px 로 부풀렸다

번역 컬럼을 열면 화면이 통째로 비었다. 재 보니 `.reader-stage` 폭이 **8,385px**, 본문이 x=3416 —
`justify-content: center` 가 본문을 화면 밖으로 밀어낸 것이었다.

원인은 `.reader-stage { width: max-content }`. 본문 안에는 breakout 요소가 있고
(`.blk-formula { width: clamp(100%, calc(100% + 280px), 90vw) }`, `.table-wrap { width: max(100%, 90vw) }`),
`max-content` 로 내재 크기를 물으면 이것들이 통제 없이 부푼다. 게다가 논문 폭 고정을 위해
`max-width: none` 을 걸어 둔 상태라 상한도 없었다.

→ 무대 폭은 **App 이 계산해 인라인으로 준다**: `본문 폭 + 간격 + 번역 컬럼 + 여백`.
`justify-content` 도 `flex-start` 로 바꿔 남는 폭이 생겨도 본문이 안 밀리게 했다.

> 교훈: 내재 크기(`max-content`/`min-content`)는 breakout(`90vw`) 요소가 있는 트리에서 쓰면 안 된다.

### 2.12 P2 렌더러 실측 — 문장 호버 연결은 오프셋으로 못 푼다

모델이 준 span 은 **원문 문자열(`block.text`) 기준 오프셋**인데, 화면 DOM 은 그 문자열이 아니다.

| 어긋나는 이유 | 예 |
|---|---|
| `$...$` 가 KaTeX 글리프로 바뀐다 | `$\mu_1$` → `<span class="katex">…` 노드 수십 개 |
| 인라인 태그 마크업이 사라진다 | `<sup>3</sup>` → 텍스트 `3` 만 남음(꺾쇠 7글자 증발) |
| Bionic 모드가 단어를 쪼갠다 | `conducted` → `<b>con</b>ducted` = 텍스트 노드 **2개** |

→ **단어 수열 정렬**로 푼다(`translate/align.ts`). ① 원문에서 수식·태그를 *같은 길이 공백*으로 지워
오프셋을 보존하고 ② DOM 텍스트 노드를 이어붙여 글자마다 (노드, 오프셋)을 기억한 뒤
③ 두 단어열을 좁은 창(10) 안에서 그리디 정렬한다. 수식 단어는 양쪽 모두에서 빠져 자동으로 건너뛰어진다.
Bionic 이 쪼갠 조각은 ②에서 다시 한 단어로 붙는다.

실측: 양방향 모두 정확. 번역 문장 3개를 호버하니 각각 대응 영문장이 정확히 잡혔고,
반대로 영문 문장 위 `caretRangeFromPoint` → 원문 오프셋 → span 인덱스도 맞았다.

### 2.13 ⚠️ 견적의 출력 계수가 절반이었다 — 문장 정렬은 영문을 되돌려받는다

32쪽 133블록 전문 번역 직후 원장을 봤다.

| 항목 | 실제 | 견적(구) | 비 |
|---|---|---|---|
| 입력 | 126,889 | 124,064 | **1.02** |
| 출력 | 48,376 | 20,091 | **2.41** |
| 5시간 한도 | **2.255%** | 1.173% | 1.92 |

입력은 사실상 정확한데 출력만 2.41배였다. 원인은 **D13 의 왕복 제약**이다 —
모델이 한국어와 함께 원문 앵커(`en`)를 그대로 되돌려주므로 출력이 "한국어만" 견적의 배가 된다.
§2.5 가 "문장 정렬을 켜면 약 1.7배" 라고 적어 뒀는데 **견적 코드가 그걸 반영하지 않았다.**

수정: 출력 계수를 **기능별**로 두고(`FEATURE_OUT_RATIO`), 출력 쪽 EWMA(`observeOut`)를 따로 돌린다.
출력에는 입력 보정계수 `k` 를 곱하지 않는다 — `k` 는 에이전트 오버헤드까지 포함한 *입력* 편차다.

> **`EST_RULES_VERSION` 을 원장 행에 넣었다.** 계수를 고치면 반드시 올려라.
> `est_out` 은 기록 시점 계수로 계산된 값이라, 계수를 바꾼 뒤 옛 행으로 EWMA 를 복원하면
> 새 계수 위에 옛 편차가 한 번 더 곱해진다(2.41 을 고쳤는데 2.41 을 다시 학습 → 5.8배).

수정 후 재측정(다른 논문, 5배치): 입력 1.02 · 출력 1.04 · 합계 오차 **3.7%**.

### 2.14 ⚠️ agy 로그인 교착 — P1 통과 이후에도 앱을 새로 켜면 첫 턴이 못 나갔다

증상: 문서 번역 시작 → 즉시 `auth`. 그런데 **같은 인자·같은 cwd·같은 HOME 으로 셸에서 돌리면 정상**이고
`agy -p "/usage"` 도 5시간 98% 남았다고 답한다. 즉 로그인은 살아 있었다.

원인은 순환이었다:

```
§2.9 규칙: 진단 목적으로 agy 를 부르지 않는다
  → agyHealth() 는 강제하지 않으면 probe 를 안 한다 → loggedIn: false ("아직 확인 전")
  → AgyBackend.stream() 이 loggedIn 을 요구해 turn 을 막는다
  → 턴이 안 나가니 markLoggedIn() 이 안 불린다 → loggedIn 계속 false
```

`resolveBackend()` 는 `ai.agyOk` 성공 이력으로 agy 를 고르는데, **백엔드 안에서 한 번 더 게이트**를 걸어
스스로 막고 있었다. P1 검증 때는 그 세션에서 이미 probe 를 돌린 뒤라 안 걸렸다.

고침: `agyUsable(h)` — 실제로 확인해서(`checkedAt>0`) 미로그인이면 막고, **한 번도 확인 안 했으면**
`ai.agyOk` 또는 `ai.backend === "agy"`(사용자가 명시적으로 고름)일 때 통과시킨다.
진짜 미로그인은 **턴 자체**가 auth 로 알려 준다 — §2.9 가 원래 말한 방식이다.

> 교훈: "진단하지 마라" 규칙을 넣을 때는 **그 상태를 요구하는 게이트가 어디에 또 있는지** 전수로 확인해야 한다.

---

## 3. 아키텍처

```
렌더러   ai:stream(job, onDelta)   ai:cancel(jobId)   ai:estimate(job)   ai:status()
   │
main ├─ AIBackend  stream(system, user, signal) → AsyncIterable<delta>
   │    ├─ agy 사이드카 풀   상주 stream-json 세션 × 2      ← 기본
   │    └─ BYOK REST        기존 streamProvider 재사용      ← 폴백
   │
   ├─ 번역 캐시     docs/<id>/ai/translations.json   텍스트 해시 키
   ├─ 사용량 원장   <appData>/Galpi/usage.jsonl      append-only
   ├─ 견적·브레이크 estimate() / 잡 예산 / 차단기
   └─ quota 폴러   agy -p "/usage"                  무과금, 5분 주기
```

**어댑터 경계를 지키는 것이 이 설계의 핵심이다.** D1이 틀렸을 때 되돌리는 비용이 파일 하나가 된다.

### 3.1 사이드카 기동

```bash
agy --print= --agent galpi --model gemini-3.7-flash-low \
    --input-format stream-json --output-format stream-json
```

- `-p`는 값을 요구한다. **`--print=` 처럼 빈 값**을 붙여야 한다 (`-p --input-format` 은 rc=2).
- 입력: 한 줄 = 한 턴
  ```json
  {"event":"user","message":{"content":"프롬프트 텍스트"}}
  ```
  `{"role":"user","text":...}` 는 안 먹는다. `user` 외 이벤트는 미지원.
- **한 줄이라도 파싱 에러면 세션 전체가 rc=1로 즉시 죽는다.** 뒤 턴은 실행조차 안 된다.
  → 직렬화를 엄격히 검증하고, 죽으면 자동 재기동.
- **턴별 usage는 `step_update`의 `state:"DONE"`에 있다. `result.usage`는 누적값이다.**
  헷갈리면 회계가 2~6배 부풀려진다.
- 워커 2개: `#1 대화형`(선택 번역·질문, 저지연 유지) / `#2 배치`(전문 번역·요약).
- 유휴 5분 종료, 필요 시 재기동(5초). **5분 이상 유휴 생존은 25초까지만 검증됨** — 이 정책이 그 불확실성을 우회한다.
- **cwd는 앱 전용 빈 폴더**를 준다. 사용자 문서 폴더를 주면 agy가 거기에 `brain/`·`conversations/`를 만든다.
- conversation db GC 필요 (사용자 홈에 이미 1.0GB / 820개가 쌓여 있다).

### 3.2 미니멀 에이전트 (앱이 생성·갱신)

`~/.gemini/config/agents/galpi/agent.md`

```markdown
---
name: galpi
description: Galpi paper reader - translation and analysis only
tools:
    - send_message
hidden: true
---

# Agent System Instructions

You are a translation and analysis engine embedded in a paper reader.
Answer the request directly. Never call tools other than send_message.
```

- `hidden: true` — 사용자가 평소 쓰는 agy 목록에 안 뜬다.
- **`finish`를 넣지 마라.** 턴당 모델 호출이 2배 된다.
- 조사 중 만들어 둔 테스트용 `~/.gemini/config/agents/gmini/` 는 불필요하면 지워도 된다.

---

## 4. 데이터 스키마

### 4.1 사용량 원장 — `<appData>/Galpi/usage.jsonl` (NDJSON append-only)

```ts
interface UsageRecord {
  v: 1;
  id: string;            // 호출 id (재시도 상관용)
  ts: string;            // 로컬 ISO. 앞 10자로 날짜 prefix 매칭
  job_id: string;        // 사용자 행동 1회. 팬아웃된 N호출을 묶는 유일한 키
  doc_id: string;
  doc_title: string;     // 비정규화 스냅샷 — 문서 삭제 후에도 원장이 읽힌다
  feature: string;       // "translate.selection" | "translate.doc" | "summary.section"
                         // | "keyword" | "qa" | "figure.describe"  (점 네임스페이스로 prefix 집계)
  scope: { kind: "selection"|"blocks"|"pages"|"section"|"doc";
           block_ids?: [string, string]; n_blocks?: number;
           pages?: [number, number]; section_id?: string };
  backend: "agy" | "rest";
  provider: string;      // "gemini" | "openai" | "anthropic"
  model: string;
  usage: { in: number; out: number; think: number;
           cache_read: number; cache_write: number };   // 4종이 아니라 5종
  in_chars: number; out_chars: number;                  // 계수 보정용
  est_in: number; est_out: number;                      // 사전 견적 — 실제와 나란히 남겨야 계수가 학습된다
  cost: { usd: number; price_v: string };               // 기록 시점 단가로 확정. 소급 재계산 금지
  quota_delta?: { w5h: number; weekly: number };        // agy 백엔드일 때
  ms: number;
  ok: boolean; err?: string;                            // "http_429" | "timeout" | "parse"
  try: number;
}
```

규칙:
- **프롬프트·응답 텍스트는 절대 저장하지 않는다.** 미공개 논문 본문이다. 글자수만 남긴다.
- `cache_write`를 `in`에 접지 마라 — Anthropic `cache_creation_input_tokens`는 1.25배 단가다.
- **SQLite 안 쓴다.** 현 `dependencies`에 네이티브 모듈이 0개이고 ad-hoc 서명 배포에 macOS 26 크래시 전력(`d403c78`)이 있다. 연 10MB 규모라 전체 스캔 수십 ms.
  탈출구: `node:sqlite`는 Node 22 내장 → Electron 37+ 업그레이드 후에 옮겨라. 지금 말고.
- 파생 캐시: `docs/<doc_id>/ai/usage.json` (문서 삭제 시 함께 소멸, 원장은 존속)
- 집계는 앱 시작 시 원장을 main 메모리로 한 번 읽어 인메모리 Map:
  `Map<doc_id,…>` / `Map<"YYYY-MM-DD",…>` / `Map<job_id,…>`
- 실시간 갱신은 기존 `docs:changed` 패턴(`preload.ts:58-64`)을 복제해 `usage:changed` 채널. 200ms 디바운스.
- 롤업(원장 5만 행/20MB 초과 시 90일 이전을 접기)은 **지금 구현하지 마라.**

### 4.2 번역 캐시 — `docs/<doc_id>/ai/translations.json`

```
key = sha256( normalizeText(text) | 대상언어 | 모델 | 프롬프트버전 )
val = { ko, seg?, model, ts, usage }
```

- **블록 id가 아니라 텍스트 해시.** 블록 id는 재추출하면 밀린다.
- 앱 재시작·PDF 재추출을 견딘다.
- 원자적 쓰기(tmp → rename).
- 프롬프트·모델을 바꾸면 키가 달라져 자동 무효화. 구버전은 남기고 LRU 정리.
- **대가**: 프롬프트를 한 번 손보면 캐시 전량 무효 → 5편 재실행 ≈ 9%. 프롬프트 버전을 올리기 전에 감안할 것.

### 4.3 문서 종류 판정 (추출 시 1회, `document.json`에 기록)

```python
is_vector = len(page.get_fonts()) > 0 or len(page.get_text().strip()) > 0
```

라이브러리 실측: 5편 중 4편 벡터, MacKinlay 1996만 스캔(텍스트 0자·폰트 0종·페이지당 4300×6000 이미지 1개).

---

## 5. 검증된 번역 프롬프트

**그대로 쓸 것.** 4–6쪽 23블록 / 8–11쪽 15블록 전부 왕복 검증을 통과했고,
LaTeX(`$\mu_{1}$`, `$\sigma_{\zeta_{i}}^{2}$` 등)이 한 글자도 안 깨졌다.

```
너는 금융·계량경제 논문 전문 번역가다. 아래 JSON 배열의 각 블록을 한국어로 번역하되,
**문장 단위로 정렬해서** 돌려줘라.

규칙:
1. 각 블록의 text 를 영어 문장 단위로 쪼갠다. 약어의 마침표(e.g., i.e., Fig., et al., 숫자 소수점)는 문장 끝이 아니다.
2. 각 영어 문장에 대응하는 한국어를 짝지어라. 한국어 어순 때문에 2개 영문장이 1개 한국어 문장이 되면
   en 배열에 두 문장을 넣고 ko 는 하나로 준다. 반대도 마찬가지.
3. $...$ 로 둘러싸인 LaTeX 은 한 글자도 바꾸지 말고 그대로 둔다.
4. 학술 용어는 국내 재무학 관례를 따르되, 처음 나올 때만 괄호로 원어 병기.
5. 설명·머리말 금지. 출력은 오직 JSON.

출력 형식:
[{"id":"b0028","seg":[{"en":["원문 문장1"],"ko":"번역1"},{"en":["원문2","원문3"],"ko":"번역2"}]}, ...]

en 배열 안의 문자열은 원문에서 **글자 그대로** 잘라낸 것이어야 한다. 다시 이어붙이면 원문이 되어야 한다.
```

- **왕복 제약이 핵심이다.** 이게 있어야 호버 앵커를 문자열 검색으로 정확히 잡을 수 있고,
  문장 분리기의 약어 오판(`e.g.`, `Fig.`)을 우회한다.
- 되짚기는 공백 차이를 흡수하도록 `\s+` 정규식으로 느슨하게 매칭한다(검증 시 99.5% 커버리지).
- **최적화 후보(P2에서 재볼 것)**: `en`에 문장 전체 대신 **앞 4단어만** 앵커로 받아 본문에서 찾는다.
  되돌려받는 양이 1/10로 줄어 문장 정렬 비용 1.7배 → 1.1배가 된다.

### 5.1 페이지를 가로지른 문장

이미 `app/src/render/pagemerge.ts`가 해결한다. 보수적으로 잇는다 —
페이지 경계 + 앞이 문장 미완(`.?!`로 안 끝남) + 뒤가 소문자·숫자 시작. 줄 끝 하이픈도 붙인다.

**번역은 반드시 병합된 본문(`textOverride`)을 봐야 한다.** 조각째 넘기면 모델이 뒷부분을 지어낸다.
실측 사례(Kothari & Warner 8→9쪽):

```
8쪽 끝  : … This contrasts with short-horizon
9쪽 시작: methods, which are relatively straightforward and trouble-free.
번역    : 이는 비교적 명쾌하고 문제가 적은 단기(short-horizon) 방법론과 대조를 이룬다.
```

**B 뷰 정책**: 합쳐진 문단은 **시작한 페이지의 카드**에 넣고, 다음 페이지 카드 맨 위에
`⤶ 앞 쪽 문단에서 이어짐` 칩을 둔다(클릭 시 해당 문단 하이라이트).
양쪽 중복 표시는 연속 스크롤에서 같은 문단을 두 번 읽게 되어 기각.
흡수된 조각의 bbox는 살려 둔다 — 지면 호버가 앞 쪽 번역을 가리켜야 하므로.

---

## 6. 지금 코드의 결함 (P0에서 고친다)

| # | 결함 | 위치 | 왜 지금 |
|---|---|---|---|
| **H1** | API 키가 평문으로 디스크에 저장된다 | `app/electron/main.ts:248-252` + `app/src/store/useStore.ts` `persistSettings` | 앱 지원 폴더를 읽는 아무 프로세스나 Gemini·OpenAI·Anthropic 키를 가져간다. `safeStorage.encryptString()`으로 분리 |
| **H2** | `settings.json`을 통째로 덮어쓴다 | `main.ts:248-252` (tmp+rename 없음) / `useStore.ts` `persistSettings`가 **6개 키만** 보낸다 | ① 쓰기 중 크래시하면 타이포·폰트·키맵·프리셋 전손 ② main이 쓴 `pythonPath`가 렌더러 저장 한 번에 날아간다 — **AI 설정이 늘면 곧 터진다.** 원자적 쓰기 + 부분 병합 |
| **H3** | 429를 재시도한다 | `main.ts:499-502` — 900ms 쉬고 1회 재시도 | 한도성 429면 `gemini-guard`가 제거한 바로 그 패턴. **429는 차단기(trip) 대상.** 재시도는 500/503/529만 |
| — | *(위 H1~H8 중 H5 를 뺀 전부가 P0 에서 해소됨. H5 는 P2)* | | |
| **H4** | `migrateLegacyDataDir` 죽은 코드 | `main.ts:38-48`, 호출 `main.ts:799` | PaperReader 폴더를 2026-08-26에 삭제했다. 제거 |
| **H5** | `rasterize.py` `dpi=200` 고정 | `pipeline/rasterize.py:41` | 스캔본 원본이 4300×6000인데 1434×2000으로 굽는다. 해상도 2/3 손실 |
| **H6** | 취소가 없다 | 코드 전체에 `AbortController` 0건 | 스트리밍 중 취소 불가. 전문 번역에 필수 |
| **H7** | usage를 받아놓고 버린다 | `main.ts:474-480` | Gemini `usageMetadata`, Anthropic `message_start/message_delta.usage`를 안 읽는다. OpenAI는 `stream_options:{include_usage:true}`가 없어 아예 안 온다 |
| **H8** | 죽은 IPC 경로 | `translate:text`(`main.ts:336`)는 `settings.ai`를 안 보고 옛 `translation.apiKey`만 읽는다. 렌더러 호출처 0건 | 제거하거나 `resolveAI`로 통일 |

---

## 7. UI 확정 사항

### 7.1 보기 A — 리플로우 ‖ 번역 (기본)

- 블록 행 정렬. 한국어가 짧아 오른쪽에 여백이 생기는 것은 **감수하기로 확정**(사용자 판단).
- 수식 블록은 두 컬럼에 걸쳐 하나로.
- 페이지 구분은 얇은 `N 쪽` 마커.
- ~~캔버스(팬/줌) 안 붙인다.~~ → **붙인다(D27, 2026-08-26 사용자 확정).** 보기 B 와 같은 `useCanvas` 훅을 쓴다.
  타이포 패널로 조판을 다시 하는 길은 그대로 두되, 확대·이동도 함께 된다.
  카드 행 정렬은 배율만큼 환산해야 한다 — `getBoundingClientRect()` 는 화면px, `style.top` 은 지역px 이다
  (`stageScale()` 로 무대 자신의 비를 구해 나눈다. 실측 정렬 오차 0px).

### 7.2 보기 B — 원본 ‖ 번역

- `⌥O`로 A↔B 전환. **번역 패널은 자리를 지키고 왼쪽만 바뀐다.**
- 연속 스크롤(페이지 넘김 버튼 없음). 지면들이 책상 위에 놓인 낱장.
- **지면 비율 절대 불변**: `.spread{align-items:flex-start}` + `.pagehalf{aspect-ratio:<w>/<h>}`.
  번역 카드는 지면과 같은 높이, 넘치면 **안에서만** 스크롤.
- 번역 카드 폭: 오른쪽 모서리 드래그, 하한 220px, **문서별 기억**.
- 캔버스 조작:

| 동작 | 입력 |
|---|---|
| 패닝 | 두 손가락 밀기 · 빈 곳 드래그 · 가운데 버튼 · `Space`+드래그 |
| 줌 | 트랙패드 핀치 · `⌘`/`Ctrl`+휠 · 우하단 `−`/`+` · `⌘0` 맞춤 |
| 줌 기준점 | 커서 위치 |

- **줌 구현 (중요)**:
  ```js
  // 제스처 중 — 부드럽게
  pan.style.transform = `translate(${X}px,${Y}px) scale(${k})`
  // 손 떼고 140ms 뒤 — 레이아웃으로 확정 (다시 그려짐 = 선명)
  canvas.style.zoom = Z * k;  k = 1
  ```
  `will-change: transform` **금지.** GPU 레이어로 승격되면 승격 시점 해상도로 한 번만 래스터화되고,
  이후 `scale()`은 그 비트맵을 늘린다 — SVG든 한글이든 전부 뭉개진다. (이번 세션에서 실제로 겪은 버그)
  커밋 시 `X`, `Y`는 그대로 두면 된다(수학적으로 상쇄된다).

- **스크롤 핸드오프**: 번역 카드 끝에서 캔버스로 넘어갈 때 트랙패드 관성이 화면을 날린다. 세 겹으로 막는다.
  ```js
  .trscroll{ overscroll-behavior: contain }                       // 네이티브 체이닝 차단
  if(경계 && e.timeStamp - cardActive < 420){ preventDefault(); return }  // 경계 잠금
  Y -= clamp(e.deltaY, -60, 60)                                   // 관성 폭주 상한
  ```
  결과: 카드 끝까지 밀면 거기서 멈춘다. 손을 뗐다 다시 밀어야 넘어간다.

- **번역 카드 헤더**: 페이지 배지 `N / 총쪽` · 재생성 `↻`(캐시 우회) · `T`(타이포) · 자동 ON/OFF 토글.
  하단에 모델·소모·캐시 상태 한 줄.

### 7.3 원본 페이지 렌더 (D6/D7)

- 벡터: `page.get_svg_image(text_as_path=True)` → 글리프 `<path>` 정의 + `<use>` 배치.
  **`fill` 속성이 하나도 없다** → 테마 적용이 CSS 상속 한 줄:
  ```css
  .pagehalf svg { fill: var(--g-fg) }    /* 잉크색 */
  .spread      { background: var(--g-bg) } /* 종이색 */
  ```
  `id` 충돌 방지: 같은 문서의 여러 SVG를 인라인하므로 **페이지별 id 접두**를 붙여야 한다
  (`id="`, `url(#`, `xlink:href="#` 세 곳 전부).
- 스캔본: 래스터 + 블렌드모드 근사(2치 이미지라 근사가 정확하다)
  ```css
  [data-t="sepia"] img{ mix-blend-mode:multiply; filter:sepia(.32) saturate(1.1) brightness(1.02) }
  [data-t="dark"]  img{ mix-blend-mode:screen;   filter:invert(1) brightness(.90) contrast(1.06) }
  ```
- **가상화 필수**: 벡터 페이지는 DOM 노드가 **쪽당 1,700~1,900개**. 51쪽이면 9만 노드라 못 버틴다.
  뷰포트 근처 3~5쪽만 실체화하고 나머지는 자리표시자.

### 7.4 문장 호버 연결

- 번역 쪽: 문장 `<span data-g="블록id-그룹index">`
- 원본 쪽(B): `document.json`의 **블록 bbox**를 투명 사각형으로 얹는다.
  PDF 좌표와 SVG viewBox가 같은 좌표계 → `left: x0/w*100%` 식 % 변환. 줌과 무관하게 따라간다.
- 양방향. **원본 쪽은 블록 단위**(MinerU bbox가 블록까지). 문장 단위까지 가려면 OCR 줄 좌표가 필요한데 지금 값어치보다 비싸다.

### 7.5 타이포그래피 통합 (D15)

| 축 | 처리 | 이유 |
|---|---|---|
| 글꼴 | **연동 기본, 잠금 해제 가능** | CSS 폰트 스택이 라틴/한글을 각각 맡는다. "Iowan Old Style + 본명조" 같은 **짝**으로 고르면 한 컨트롤로 충분 |
| 크기 | **독립** | 영문 세리프 16.5px과 한글 15.5px은 같은 크기가 아니다. 번역 기본값 **14px**(사용자 확정), 범위 8–22px |
| 줄간격 | **독립** | 한글은 더 넓어야 한다. 기본 **2.30**(사용자 확정 — 1.75 는 답답했다), 범위 1.3–2.6 |
| 자간 | **독립** | 좁은 컬럼 한글은 살짝 음수가 낫다. 기본 0, 범위 −0.04~+0.10em |
| 폭·정렬·테마 | **공유** | 지면 전체의 성질 |

UI:
- 타이포 패널 맨 위에 `원문 | 번역` 세그먼트. 아래 다이얼은 선택된 대상에 적용.
- 글꼴 행에만 **연동 자물쇠**.
- 공유 축은 별도 구역에 둬서 "둘 다에 적용된다"가 눈에 보이게.
- 번역 카드의 `T`는 그 패널 **번역 탭으로 가는 지름길** — 세 다이얼 팝오버 + "타이포 패널에서 전체 조절 →".
  **값의 출처는 패널 하나.**
- 프리셋 공유(`app/src/presets/share.ts`)는 `sanitizeTypography`에 번역 축 키만 추가.

### 7.6 기존 UX 제약 (WORKLOG에서 사용자가 명시적으로 거부한 것)

- **본문 위 hover UI 금지.** 신규 기능은 단축키 + 화면 가장자리/하단.
- 선택 시 자동 팝업 금지 (형광펜 선택과 충돌).
- 키 매칭은 `e.code` 기반(`keymap.ts`) — mac에서 Alt+문자가 데드키로 바뀌는 문제 회피.

---

## 8. 비용 방어 3단

| 단 | 장치 | 동작 |
|---|---|---|
| 1 | **사전 견적 게이트** | "전문 번역 — 7회 호출, 입력 약 56k / 출력 약 29k, 5시간 한도의 **1.8% (±40%)**". **±범위를 반드시 같이 보인다** — 단일 숫자는 한 번 빗나가면 견적 기능 전체의 신뢰가 날아간다. 배치 크기·범위를 그 자리에서 조절 |
| 2 | **진행 중 위젯**(우하단) | `번역 128/251 · 0.9% / 견적 1.8% · [중단]`. **배치 경계에서만** 중단해 이미 번역된 블록은 살린다. 재개 시 캐시 있는 블록은 스킵 → 중단이 손실이 아니라 일시정지. **실제가 견적의 1.5배를 넘으면 자동 정지 후 재확인** |
| 3 | **차단기** | 429/quota 1회 → 리셋까지 폐쇄. 연속 실패 3회 → 그 기능 세션 종료. 상한은 **호출 수가 아니라 토큰·한도% 단위**(배치를 키우면 호출 수는 줄고 비용은 그대로). **한도에 걸려도 읽기는 절대 안 막는다** |

한도 조회는 무과금이므로 큰 잡 전후 + 5분 주기로 폴링:
```bash
agy -p "/usage" --output-format json
# → command.data.groups[].buckets[] = {id, name, description, window("weekly"|"5h"),
#                                      remaining_fraction, reset_time(UTC)}
```

미터 UI 배치 **순서: C → B → A** (대시보드보다 "지금 얼마 태우고 멈출 수 있나"가 먼저):
- **C** 진행 중 잡 위젯 (우하단) ← 유일하게 실제로 돈을 아끼는 UI
- **B** 라이브러리 카드 배지 (`32p · 3일 전 읽음 · 42k`)
- **A** 상단바 칩 + 팝오버

혼동 방지 3규칙:
1. 잔량 바에는 **반드시 재설정 시각**을 붙인다.
2. 누적 숫자에는 **% 금지**(분모가 없다). 상한을 걸었을 때만 예외.
3. 계정 잔량 옆에 "앱 밖 사용 포함" 각주 한 줄.

> 잔량(%)은 전망·소진형, 누적(토큰)은 회고·단조증가. **위치와 시각형을 분리할 것.**

---

## 9. 실행 단계

각 단계는 통과 조건을 하나씩 갖는다. **못 채우면 다음으로 안 간다.**

### P0 — 위생 · 계측 (백엔드 무관)

여기서 만드는 건 어느 백엔드를 골라도 그대로 쓴다. D1이 틀렸을 때 되돌리는 비용을 줄이는 단계.

- [x] **H1** API 키 → `safeStorage`. `settings.json`에는 provider/model 선택만 → `electron/settings.ts`, `secrets.json`(0600, `{v,enc,data}`)
- [x] **H2** `settings.json` 원자적 쓰기(tmp→rename) + **부분 병합**. 렌더러가 6개 키만 보내도 main 소유 키가 안 죽게
- [x] **H3** 429 → 차단기(`ai/breaker.ts`). 재시도는 5xx/네트워크만, 백오프 600→1800ms, 이미 델타가 흐른 뒤면 재시도 금지
- [x] **H4** `migrateLegacyDataDir` 제거 (+ `resolvePython` 의 PaperReader 폴백도 죽은 코드라 함께 제거)
- [x] **H7** 응답에서 usage 줍기 — 3사 모두. **정규화 규칙: `in` 은 캐시 미적중 입력만, `out` 은 thinking 제외** (제공자마다 포함 관계가 달라 안 맞추면 이중계상)
- [x] **H8** 죽은 `translate:text` 제거 (`translate:stream` 도 `ai:stream` 으로 대체)
- [x] `AIBackend` 인터페이스(`ai/types.ts`) + `RestBackend` 로 지금의 BYOK 를 그대로 꽂음
- [x] **H6** `AbortController` 기반 취소 + `ai:cancel(jobId)` — 대기 중이면 큐에서 제거, 실행 중이면 fetch 중단
- [x] 동시성 2 큐 (`ai/queue.ts`)
- [x] 사용량 원장 §4.1 + `usage:changed` 브로드캐스트 + 문서별 파생 캐시
- [x] 타입드 에러 — `config|auth|rate_limit|server|network|parse|canceled|breaker`. **Gemini 는 잘못된 키에 401 이 아니라 400 INVALID_ARGUMENT 를 준다**(실측) → 본문 매칭으로 auth 승격
- [x] (추가) 견적 EWMA 보정계수를 원장에서 복원 — 재시작해도 견적 정확도가 리셋되지 않는다

**통과 조건** · ✅ 충족. 실제 앱을 CDP 로 붙여 렌더러에서 직접 검증:
선택 번역 TTFT 1.18초·델타 수신·usage `in=86 out=21` 원장 적재, 스트림 중 취소가 실제로 끊김
(취소 시점 델타 1개, 700ms 뒤에도 1개). 합성 원장 8행으로 EWMA 복원 확인(bias 1 → 0.837, 견적 143 → 120, 실제 115).

### P1 — agy 사이드카

- [x] agy 탐지(PATH + `~/.local/bin/agy` + brew 경로) → `/usage` 한 방으로 로그인 확인(무과금) → 온보딩 카드
      (터미널 1회 실행 안내 + `open -a Terminal` 버튼 + 재확인)
- [x] 미니멀 에이전트 `galpi` 생성·갱신 (§3.2). 매 기동 시 내용 대조 — 사용자가 손대도 복구된다
- [x] ~~상주 세션 × 2~~ → **웜 스페어 풀**(§2.8). 재기동·백오프(0/1/4/15초)·유휴 5분 종료
- [x] NDJSON 직렬화 **엄격 검증** — `serializeTurn()` 이 JSON 왕복까지 대조하고 개행을 막는다
- [x] 턴별 usage는 `step_update{step_type:"agent_response", state:"DONE"}.usage` (실측으로 `result.usage` 누적분과 일치 확인)
- [x] `/usage` 폴러 (무과금, 5분). agy 가 없으면 아예 안 띄운다
- [x] conversation db GC — **갈피가 만든 대화만.** 아래 참조
- [x] `ai:status()` — 백엔드·로그인·에이전트·풀·한도·차단기·큐·견적보정 한 번에
- [x] 계정 슬롯 스키마 (`ai.accounts[] / ai.activeAccount`, `env:{HOME}` 로 전환. UI 는 나중)
- [x] (추가) 문서를 열 때 `agyPrewarm()` — 첫 번역 TTFT 6초 → 1.4초

> **conversation db GC 는 나이 기준으로 훑으면 안 된다.** 이 기계의 `conversations/` 에는 865개·1.0GB 가
> 있는데 **대부분 사용자 본인의 agy 사용 기록**이다. 갈피는 `init` 의 `conversation_id` 를 기록해
> **자기가 만든 것만** 지운다. SQLite 는 `.db` 옆에 `-wal`/`-shm` 을 남기므로 본체만 지우면 고아가 쌓인다(실측).
> 턴마다 세션을 버리는 구조라 10초 디바운스 스윕이 자동으로 돈다 — 검증 후 865 → 865 로 잔여 0.

**통과 조건** · ✅ 충족.
- 웜 스페어 TTFT **1.01 / 1.41 / 1.81초** (헤드리스·실앱 CDP 양쪽). 콜드는 5.9~6.6초.
- 스페어를 `SIGKILL` 로 죽인 뒤 다음 턴이 6.5초에 자동 복구, 결과 정상.
- 취소가 **두 국면 모두** 동작: 스트림 중(델타 1개에서 끊고 1.5초 뒤에도 1개), 그리고 `acquire()` 대기 중.
- 턴별 usage `in≈3,956` 이 **턴을 거듭해도 안 늘어난다**(상주 세션이면 3,885→3,985→4,090으로 증가).
- 견적 EWMA 보정계수 agy 0.998 — 사실상 정확.

### P2 — 번역 (핵심)

**진행 상황: ✅ 완료.** 2026-08-26 실앱(CDP)에서 종단 검증했다.

- [x] **H5** `rasterize.py` dpi 하한화 + 쪽별 SVG 추출 (`vectorize.py` 를 따로 만들지 않고 rasterize 안에 합쳤다 —
      벡터/래스터 판정이 SVG 를 뽑아 봐야 나오므로 두 파일로 나누면 같은 일을 두 번 한다)
- [x] 문서 종류 판정 → `pages[].is_vector` + `pages[].svg` (§4.3 은 문서 단위였으나 **쪽 단위**가 맞다. §2.10)
- [x] 보기 A 구현 (§7.1) — `translate/TranslateColumn.tsx`. D19(컬럼은 `.reader-content` 밖)·D20(JS 행 정렬) 준수
- [x] 보기 B 구현 (§7.2, §7.3) — `translate/SourceView.tsx`. 캔버스·패닝·zoom 확정(D12)·쪽 마커·이어짐 칩
- [x] **SVG 페이지 가상화** — IntersectionObserver(`rootMargin:120%`). 51쪽 문서에서 동시 실체화 **3쪽**
- [x] 번역 캐시 §4.2 — `ai/translationCache.ts`. 키에 마스킹 규칙 버전 추가(D23)
- [x] 배치 스케줄러 `ai/translateDoc.ts` — 뷰포트 우선(렌더러가 순서를 준다), 캐시 적중 우선 방출,
      배치 동시성 1(선택 번역용 큐 한 칸 확보), 한도/차단기/인증 오류 시 남은 배치 즉시 포기
- [x] 수식 마스킹/복원/앵커 `ai/segment.ts` — 한 파일에 묶었다. **단위 테스트 9개 통과**
- [x] 문장 호버 연결 §7.4 — `translate/align.ts`. **단어 수열 정렬**로 원문 오프셋 ↔ DOM Range 를 잇는다(§2.12)
- [x] `pagemerge` 결과를 번역 입력으로 사용 §5.1 + 이어짐 칩 — 51쪽 문서에서 칩 15개, **8→9쪽 예시 포함**
- [x] 타이포 통합 §7.5 — 패널에 `원문 | 번역` 세그먼트 + 글꼴 연동 자물쇠. 공유축(본문 폭)은 별도 구역
- [x] (추가) **견적 출력 계수 오류 수정** — §2.13. 문장 정렬은 영문을 되돌려받아 출력이 2.41배다
- [x] (추가) **agy 로그인 교착 수정** — §2.14. P1 이 통과했는데도 앱을 새로 켜면 첫 턴이 못 나갔다
- [x] (추가) 잘린 응답에서 온전한 객체만 건지기 — 배치 하나가 통째로 날아가던 것을 막는다(단위 테스트 2개)
- [x] (추가) `pipeline/repage.py` — MinerU 재실행 없이 `pages[]` 만 다시 굽는다(기존 5편에 SVG·고DPI 소급 적용)
- [~] 문장 정렬 비용 최적화 — `translate.blocks.prefix` 프롬프트와 `resolve(mode:"prefix")` 는 구현·테스트 완료.
      **실모델 3변형 비용 비교는 미수행**

**통과 조건** · ✅ 충족. 2026-08-26 실앱 CDP 검증:
- 32쪽 논문 133블록 전문 번역 **26호출 전부 성공**, 실제 소모 **2.255%** (5시간 한도).
- 견적 정확도(수정 후): 배치별 입력 **1.02배** · 출력 **1.04배**, 합계 오차 **3.7%** — ±40% 안.
- 중단 → `canceled`, 그때까지 39블록이 캐시에 남고 재계산한 견적이 2.4% → 2.2% 로 줄었다. **중단은 손실이 아니라 일시정지.**
- 재개: 파싱 실패로 빠졌던 5블록만 다시 돌려 **133/133**.
- 문장 호버 **양방향** 동작(번역 문장 → 원문 문장 하이라이트, 그 반대도).
- 벡터 쪽 **477% 확대에서 선명**. `<svg>` 에 `fill` 속성 0개 → `computedFill` 이 테마색(`--fg`)을 그대로 받는다(D6 확인).

### P3 다음 세션 착수점

1. **미터 UI** — 순서 C → B → A (§8). C(진행 위젯)는 `translate/TranslateBar.tsx` 로 이미 있다.
   남은 것은 B(라이브러리 카드 배지)와 A(상단바 칩 + 팝오버). 축 3 시안이 아직 없다.
2. **`prefix` 앵커 모드 실측** — `translate.blocks.prefix` 는 구현·테스트만 됐고 실모델 비용 비교가 없다.
   `FEATURE_OUT_RATIO["translate.blocks.prefix"]` 는 **잠정값 1.35** 다. 한 편 돌려 보고 계수를 확정할 것
   (§2.13 의 full 모드 2.41 처럼). 여기서 출력이 절반이면 논문당 2.26% → 1.4% 대로 떨어진다.
3. 3단 브레이크(§8 단3)의 **자동 정지** — "실제가 견적의 1.5배를 넘으면 자동 정지 후 재확인" 이 아직 없다.
   지금은 견적이 맞으니 급하지 않지만 프롬프트를 고치면 다시 필요해진다.

**앱을 스크립트로 몰아 보려면**: dev 실행 중 `--remote-debugging-port=9222` 가 열려 있다(`main.ts`, `isDev` 가드).
Node 20 에는 전역 WebSocket 이 없어 `net` 위에 최소 CDP 드라이버를 얹어 썼다.

### P3 — 사용량

- [ ] 견적 계산기 §2.4 (블록 타입별 계수 + EWMA 보정)
- [ ] 3단 브레이크 §8
- [ ] 미터 UI C → B → A
- [ ] 축 3 시안 필요 (배치·밀도)

**통과 조건** · 전문 번역 도중 중단이 실제로 먹고, 원장 합계가 `/usage` 실측 변화와 부합한다.

### P4 — 이해

- [ ] 요약 (3줄 / 전문 / 섹션별)
- [ ] 키워드 사전 → 기존 형광펜 규칙 엔진에 주입
- [ ] 오토 하이라이트. **AI 규칙과 사용자 규칙에 출처 필드를 넣어 분리** — 안 하면 재생성이 사용자 형광펜을 지운다
- [ ] 추천 질문 칩 (요약 만들 때 같이 뽑아 둔다)
- [ ] `--json-schema`로 구조화 출력
- [ ] `applyHighlights` 프로파일 — 규칙 50~100개면 규칙별 전체 TreeWalker 순회가 터진다

**통과 조건** · 규칙 100개 주입 상태에서 스크롤이 60fps를 유지한다.

### P5 — 대화

- [ ] 멀티턴 질문 패널 + 인용 앵커(클릭 → 본문 점프)
- [ ] **첨부 질문** — ⌘V → 임시파일 → `--add-dir`. **이미지는 긴 변 1024px로 리사이즈**(원본 페이지는 43k 토큰)
- [ ] 그림·표 설명 — bbox 크롭. `html`도 `image`도 비어 있는 표 블록이 실제로 존재하니 페이지 크롭 폴백
- [ ] 축 2 시안 필요 (번역 컬럼 + 대화 + 키워드가 동시에 뜰 때의 배치 규칙)

**통과 조건** · 실제 논문의 표 하나를 붙여넣어 질문했을 때 값을 정확히 읽는다.

---

## 10. 아직 안 한 것 · 미확정

| 항목 | 상태 |
|---|---|
| 한도 초과 시 실제 이벤트 형태 | 한도가 99% 남아 강제 못 함. `RESOURCE_EXHAUSTED` 문자열만 확인. **턴 전 `/usage` 폴링으로 우회** |
| 5분 이상 유휴 생존 | 25초까지만 검증. 유휴 5분 종료 정책이 우회 |
| figure 예외 처리 | 스캔본 다크모드에서 사진·차트 반전. bbox `clip-path` 오려내기 미검증 |
| 문장 단위 bbox | 현재 블록 단위. OCR 줄 좌표 필요 |
| 캐시 히트 재현 조건 | 9턴 중 1회. 원인 불명. **기대하고 설계하지 말 것** |
| 축 2 (패널 배치) | 시안 미작성. P5 전까지 필요. 기존 목차·주석 패널이 이미 `right:0 / 300px / z40`으로 겹친다(`styles.css:438`, `:574`) — 3개 이상 동시 표시 정책 필요 |
| 축 3 (미터 배치) | 시안 미작성. P3 전까지 필요 |
| 문장 정렬 앵커 최적화 | `prefix` 모드는 구현·단위테스트만. **실모델 비용 미측정** — 출력계수 1.35 는 잠정값 |
| 번역 카드 폭 기본값 | 380px 고정. §7.2 의 "문서별 기억"은 `state.json` `tr_width` 로 구현됨 |
| ~~번역 글자 크기 기본값~~ | **해결.** 사용자가 직접 맞춘 값으로 확정: 14px · 줄간격 2.30 · 자간 0 |
| 각주·참고문헌 번역 | 대상에서 뺐다. 각주는 접힌 `<details>` 로 끌려 나가 카드 붙일 자리가 없고, 참고문헌은 값 대비 비용만 든다 |
| 내보내기(HTML)에 번역 포함 | 안 된다. `exportHtml` 은 `.reader-content` 만 직렬화하는데 번역 컬럼은 그 밖이다(D19) |

---

## 11. 참고 좌표

### 앱 (P0 이후 구조)
```
electron/paths.ts          appSupportDir · settingsPath · secretsPath · docsRoot · usageLedgerPath · docAiDir
electron/settings.ts       원자적 쓰기 · 부분 병합 · secrets(safeStorage) · 평문키 1회 이전
electron/usage.ts          원장 append + 인메모리 집계(doc/day/job/feature) + usage:changed + 문서별 캐시
electron/ai/types.ts       AIBackend · AIError · TokenUsage   ← **백엔드 교체 지점은 여기 하나**
electron/ai/restBackend.ts BYOK REST(Gemini/OpenAI/Anthropic) — SSE 이터레이터 · usage 정규화 · 타입드 에러
electron/ai/service.ts     ai:stream / ai:cancel / ai:estimate / ai:status / ai:setKey / usage:*
electron/ai/breaker.ts     provider 차단기(429) + feature 차단기(연속 3회)
electron/ai/queue.ts       동시성 2, 대기 중 취소
electron/ai/estimate.ts    블록 타입별 계수 + EWMA 보정
electron/ai/pricing.ts     단가표(기록 시점 확정, 소급 재계산 금지)
electron/ai/prompts.ts     프롬프트 + 버전(§4.2 캐시 키에 들어간다)
electron/ai/agyBackend.ts  agy 백엔드 + 웜 스페어 풀 + agyUsable 게이트(§2.14)
electron/ai/translateDoc.ts 배치 스케줄러 + planTranslation(사전 견적 게이트)
electron/ai/segment.ts     마스킹·복원·앵커 + 잘린 JSON 건지기(D26)
```

렌더러 (P2 에서 추가):
```
src/translate/useTranslation.ts  번역 상태 단일 소유자(캐시 선적재·plan·진행·취소·카드폭)
src/translate/trBlocks.ts        번역 대상 선별 + 뷰포트 우선 정렬
src/translate/align.ts           문장 호버 좌표 변환 — 단어 수열 정렬 (§2.12)
src/translate/TranslateColumn.tsx 보기 A — 절대배치 카드 + JS 행 정렬(D20) + 쪽 마커
src/translate/SourceView.tsx     보기 B — 지면 캔버스 · zoom 확정(D12) · 가상화 · 이어짐 칩
src/translate/TranslateBar.tsx   견적 게이트 + 진행 위젯 + 5시간 한도 % 환산
pipeline/repage.py               MinerU 없이 pages[] 만 재생성(SVG·고DPI 소급 적용)
```
P1 에서 `ai/agyBackend.ts` 를 만들어 `service.ts` 의 `resolveBackend()` 한 줄만 바꾸면 된다.

- IPC 전수(P0 이전 좌표): `app/electron/main.ts` — `docs:list`:131 `docs:load`:162 `state:load`:169 `state:save`:178 `reading:update`:185 `library:load`:214 `docs:delete`:226 `settings:load`:239 `settings:save`:248 `translate:text`:336 `translate:stream`:489 `ai:listModels`:510 `pipeline:*`:597,623,638,652,668 `app:*`:692,694,731
- 푸시 채널: `docs:changed`(브로드캐스트) / `translate:delta`:495 / `pipeline:install-log`:672
- preload: `app/electron/preload.ts` — `translateStream`:41-56, `onDocsChanged`:58-64, `assetUrl`:36, `pathForFile`:66, `exposeInMainWorld`:112
- AI 경로: `resolveAI`:376 → `streamProvider`:414 → `readSSE`:391. 프롬프트 `TRANSLATE_PROMPT`:330, `TRANSLATE_SYS`:373
- 직렬 큐 참고: `extractQueue`:550, `extractActive`:551
- 스토어: `app/src/store/useStore.ts` `persistSettings` (6개 키만 보낸다)
- 레이아웃: `app/src/styles.css` `.reader-root`:174 `.reader-body`:185(이미 flex) `.reader-scroll`:186. 오버레이 패널:438, :574
- 페이지 병합: `app/src/render/pagemerge.ts`
- 키맵: `app/src/keys/keymap.ts` (`e.code` 기반)
- 프리셋: `app/src/presets/share.ts` `sanitizeTypography`

### 파이프라인
- `pipeline/rasterize.py:41` `dpi: int = 200`
- `pipeline/build_document.py` — `document.json` 조립
- venv: `pipeline/.venv/bin/python` (PyMuPDF 1.27.2.3 확인)

### 외부
- agy 바이너리: `~/.local/bin/agy` (1.1.21). 공개 릴리스 `google-antigravity/antigravity-cli`, mac arm64 tar.gz 49.9MB / 해제 177MB, 거의 매일 갱신
- 에이전트 정의: `~/.gemini/config/agents/<이름>/agent.md`
- 로그: `~/.gemini/antigravity-cli/log/`
- 데이터: `~/Library/Application Support/Galpi/`

### 기존 참고 구현 (이식할 개념만, 코드는 아님)
- `~/.claude/bin/gemini-sub` — 호출 래퍼, usage 로그 포맷
- `~/.claude/bin/gemini-guard` — 예산·차단기·잡 단위 예산(`job_id` 개념의 원형). **다계정 라우팅은 이식 불필요** (설치 1개 = 계정 1개)
- `~/.claude/bin/gemini-usage` — **폐기 대상.** PTY로 TUI를 긁는 방식인데 `agy -p "/usage"`가 무과금으로 같은 값을 준다
- `github.com/erennyuksell/ag-multi-account-switchboard` (MIT) — 가져올 것: 비밀/메타 분리, 원자적 캐시 쓰기, 토큰 회계 스키마, 43줄 동시성 풀, 타입드 HTTP 에러.
  **가져오면 안 되는 것**: quota/계정전환 서브시스템 전체(하드코딩 CLIENT_SECRET·`v1internal` 비공개 엔드포인트·IDE 사칭 UA — MIT가 커버하지 않는다), `ps` 프로세스 스크래핑, 수동 protobuf, PID 파일 락, 웹뷰 아키텍처

---

## 12. 이번 세션에서 한 것 (배경)

- 백엔드 후보 4개를 실측 비교해 D1~D3 확정
- agy 특성 12항목 실측 (§2)
- 한도 소모 모델을 2점 회귀로 도출 (§2.2)
- 번역 품질·LaTeX 보존 검증, `-low` vs `-medium` 비교 → D5
- PDF 벡터 추출 검증 → D6, 스캔본 예외 발견 → D7
- 대조 레이아웃 시안 3종 제작 → D8~D13 확정
- `~/Library/Application Support/PaperReader/` 삭제 (118MB, 테스트 데이터 5편) → H4
- 조사 중 `~/.gemini/config/agents/{gmini,galpi}/agent.md` 생성. `gmini`는 테스트용이라 지워도 된다
