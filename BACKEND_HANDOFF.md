# 갈피(Galpi) 백엔드 연동 핸드오프

> 목적: 맥 앱 ↔ 아이패드 앱 간 **데이터 동기화 서버**를 새로 구현하기 위한 정보 묶음.
> 이 문서 하나만 읽으면 백엔드를 설계·구현할 수 있도록, 현재 앱의 데이터 모델·저장 방식·제약을 모두 정리했다.
> 출처는 모두 현재 코드(`app/electron/main.ts`, `app/src/**`, `pipeline/**`)에서 직접 추출했다.

---

## 0. 한 줄 요약

갈피는 현재 **로컬 전용 Electron(macOS) 앱**이다. 모든 데이터를 `~/Library/Application Support/Galpi/` 아래 **파일**로 저장한다(DB 없음, 네트워크 동기화 없음). 목표는 이 로컬 파일 모델을 **서버에 미러링**해서 맥에서 만든 문서·하이라이트·메모·읽기상태를 아이패드에서도 보고 편집하게 하는 것이다.

핵심 설계 분기점 3가지를 먼저 못 박는다:

1. **무거운 자산 vs 가벼운 상태를 분리하라.** 문서 번들(PDF + 페이지 PNG + `document.json`)은 수~수십 MB의 **불변(immutable)** 데이터다. 하이라이트/메모/읽기위치는 수 KB의 **자주 바뀌는** 데이터다. 둘은 저장소·동기화 전략이 달라야 한다.
2. **`doc_id`가 천연 동기화 키다.** 콘텐츠 해시 기반이라 어느 기기에서 추출해도 같은 PDF면 같은 `doc_id`가 나온다(§3 참조). 별도 UUID 매핑이 필요 없다.
3. **추출은 맥에서만 가능하다.** 추출 엔진(MinerU)은 Apple Silicon/Python 의존이라 아이패드에서 못 돈다. 따라서 데이터 흐름은 **맥에서 추출→서버 업로드→아이패드 다운로드(읽기 전용 소비)**가 기본이고, 하이라이트/메모는 양방향 동기화 대상이다.

---

## 1. 현재 아키텍처 (지금 모습)

```
pipeline/   1단계 — PDF 추출 (Python 3.12 + MinerU + PyMuPDF). 맥(Apple Silicon, MLX 가속)에서만 검증.
app/        2단계 — 리플로우 뷰어 (Electron 33 + React 18 + TypeScript + Vite + Zustand)
```

- 두 단계는 중간 포맷 **`document.json`** 을 계약(contract)으로 분리됨.
- Electron **main 프로세스**가 모든 파일 IO를 담당(`app/electron/main.ts`). 렌더러(React)는 `window.paperAPI.*`(preload로 노출된 IPC)로만 데이터에 접근.
- 저장소: 로컬 파일시스템. **데이터베이스도, 서버도, 네트워크 동기화도 없음.**
- 외부 네트워크는 두 가지뿐: ① 번역/AI(사용자 본인 API 키로 Gemini/OpenAI/Anthropic 직접 호출), ② GitHub 릴리스 업데이트 확인. 둘 다 동기화와 무관.

---

## 2. 디스크 저장 레이아웃 (단일 진실 원천)

루트: `app.getPath("appData")/Galpi` → macOS 기준 `~/Library/Application Support/Galpi/`
(구버전 `PaperReader` 폴더는 최초 실행 시 자동 rename 이전 — `migrateLegacyDataDir()`. 신규 서버는 무시해도 됨.)

```
~/Library/Application Support/Galpi/
├── settings.json                 # 전역 설정 (기기 단위, §5)
├── library.json                  # 라이브러리 폴더 트리 + 문서 배정 (§6)
├── pyenv/                         # 추출 엔진 Python venv (동기화 대상 아님 — 기기 로컬)
└── docs/
    └── <doc_id>/                  # 문서 1개 = 폴더 1개
        ├── document.json         # 추출 결과(불변 계약). 본문 블록 전체. §4
        ├── status.json           # 추출 진행 상태. §4.2
        ├── state.json            # ★사용자 데이터★ 하이라이트·메모·읽기상태. §7 — 동기화 핵심
        ├── source.pdf            # 원본 PDF (불변)
        ├── pages/                # page-1.png … page-N.png (원본 페이지 래스터, 불변)
        ├── assets/               # 그림/표 이미지 등 (불변)
        └── mineru/               # MinerU 원본 중간산출물 (디버그용 — 동기화 불필요)
```

실측 예시 (한 문서 폴더):
```
the-journal-of-finance---2021---dong---a-545334d2/
  assets/ (67개), pages/ (43개 png), mineru/, document.json(203KB),
  source.pdf(736KB), state.json(767B), status.json(53B)
```

**동기화 분류:**

| 경로 | 성격 | 크기 | 동기화 |
|---|---|---|---|
| `docs/<id>/document.json` | 불변, 맥에서 생성 | 수십~수백 KB | ✅ 다운로드(맥→서버→아이패드) |
| `docs/<id>/source.pdf` | 불변 | 수백 KB~수 MB | ✅ (선택: 아이패드가 원본 PDF도 볼지 결정) |
| `docs/<id>/pages/*.png` | 불변 | 페이지당 수백 KB | ✅ (원본/리플로우 나란히보기·SourcePeek에 필요) |
| `docs/<id>/assets/*` | 불변 | 그림·표 | ✅ |
| `docs/<id>/mineru/*` | 디버그 중간물 | 큼 | ❌ 동기화 불필요 |
| `docs/<id>/status.json` | 추출 진행률 | 53B | △ 추출 끝나면 항상 `done` — 서버엔 굳이 불필요 |
| `docs/<id>/state.json` | **사용자 생성 데이터** | 수 KB | ✅✅ **양방향 동기화 핵심** |
| `settings.json` | 기기 설정 | 작음 | △ §5 참고(기기별 vs 계정 동기화 선택) |
| `library.json` | 폴더 정리 | 작음 | ✅ 동기화하면 좋음 |
| `pyenv/` | 추출 엔진 | 큼 | ❌ 기기 로컬 |

---

## 3. `doc_id` — 동기화 식별자 (가장 중요)

`pipeline/extract.py`:

```python
def make_doc_id(pdf_path: Path) -> str:
    """파일명 + 내용 해시 앞 8자리로 안정적 doc_id 생성."""
    h = hashlib.sha1(pdf_path.read_bytes()).hexdigest()[:8]
    # 결과 형태: <파일명-slug>-<sha1[:8]>
    # 예) the-journal-of-finance---2021---dong---a-545334d2
```

- **형식**: `<slug(파일명)>-<sha1(PDF바이트)[:8]>`. 정규식 `^[A-Za-z0-9._-]+$` 만 허용(경로 탈출 방지, `main.ts:211`).
- **콘텐츠 주소(content-addressed)**: 같은 PDF면 어느 기기·어느 시점에 추출해도 뒤 8자리 해시가 동일.
- **시사점**:
  - 서버 측 문서 기본키(primary key)로 `doc_id`를 그대로 써도 된다. 별도 UUID 발급 불필요.
  - 같은 논문을 맥/아이패드에서 각각 추출해도 충돌이 아니라 **자연스러운 dedup**이 된다(해시가 같으니).
  - 단, **파일명을 바꾸면 slug 부분이 달라져 doc_id가 바뀐다.** 더 견고하게 하려면 서버에서는 `sha1[:8]`(또는 전체 sha256)을 별도 `content_hash` 컬럼으로 두고 진짜 동일성 판단에 쓰는 걸 권장. slug는 표시용.
  - **권장**: 업로드 시 클라이언트가 PDF 전체의 sha256도 함께 보내 `content_hash`로 저장 → 8자리 충돌(가능성 낮지만) 방어 + 향후 재명명 견고성.

---

## 4. `document.json` 스키마 (불변 계약)

`app/src/types.ts` 와 `pipeline/build_document.py` 가 동시에 정의하는 계약. **백엔드는 이걸 파싱·변형할 필요 없이 BLOB으로 저장·전달만 하면 된다**(뷰어가 해석). 다만 목록·검색 메타는 추출해 두면 유용.

```ts
type BlockType =
  | "heading" | "paragraph" | "formula" | "table"
  | "figure"  | "caption"   | "list"    | "footnote" | "reference";

interface PageInfo {
  index: number;            // 1-indexed
  image: string;            // "pages/page-N.png" (문서폴더 상대경로)
  width_pt: number; height_pt: number;
  image_width_px: number; image_height_px: number;
  dpi: number;
}

interface Block {
  id: string;
  type: BlockType;
  page: number;
  bbox: [number, number, number, number] | null;
  level?: number;           // heading 깊이
  text?: string;
  latex?: string;           // formula
  display?: boolean;        // formula: block/inline
  html?: string;            // table
  image?: string;           // figure/폴백 이미지 (assets/ 상대경로)
  needs_review?: boolean;
}

interface PaperDocument {
  doc_id: string;
  title: string | null;
  authors?: string | null;
  journal?: string | null;
  source_pdf: string;
  page_count: number;
  pages: PageInfo[];
  blocks: Block[];          // 본문 전체 — 대부분의 용량
}
```

> `bbox`·`pages`·`page` 는 "원본 PDF 페이지 위 좌표"를 가리킨다(원본보기/SourcePeek 기능용). 이미지 경로(`image`, `pages/...`, `assets/...`)는 모두 **문서폴더 상대경로**이며, 뷰어는 `paper://<doc_id>/<상대경로>` 보안 스킴으로 로드한다(`main.ts:registerDocProtocol`). **아이패드 앱/웹뷰는 이 경로를 서버 URL(예: `https://api/.../docs/<doc_id>/<상대경로>`)로 매핑해야 한다.**

### 4.2 `status.json`
```json
{ "state": "done", "pages_done": 43, "page_count": 43 }
```
`state ∈ {"extracting","done","error"}`. 추출이 끝난 문서는 항상 `done`. 서버는 "추출 완료된 번들만 업로드"한다고 가정하면 사실상 불필요.

### 4.3 목록 카드용 파생 메타 (`DocSummary`)
`main.ts:docs:list` 가 `document.json + status.json + state.json` 을 합쳐 만드는, 라이브러리 화면용 요약. 서버 `GET /documents` 응답 모델의 좋은 출발점:
```ts
type DocSummary = {
  doc_id: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  page_count: number;
  state: "extracting" | "done" | "error";
  pages_done: number;
  finished: boolean;            // state.json 에서
  last_read_at: string | null;  // state.json 에서 (ISO8601)
};
```

---

## 5. `settings.json` (전역/기기 설정)

`app/src/store/useStore.ts` + `app/src/ai/ai.ts`. **"전역 단일"** — 문서마다가 아니라 앱 전체에 하나. 변경 즉시 디바운스 자동 저장.

```ts
interface GlobalSettings {
  typography: Typography;                 // 글꼴/크기/줄간격/여백 등 (app/src/store/typography.ts)
  fonts: UserFont[];                       // 사용자가 추가한 로컬 폰트 (name + base64 dataUrl) — 용량 큼
  ai?: AIConfig;                           // ↓ API 키 포함 — 민감정보
  keymap?: Partial<Keymap>;                // 단축키 커스텀
  customPresets?: SavedPreset[];           // 타이포 프리셋 (id, name, typography)
  reading?: Partial<ReadingOpts>;          // { bionic, sentenceBreak }
  pythonPath?: string;                     // 추출 엔진 경로 — 기기 로컬, 동기화 금지
  translation?: { apiKey?; model? };       // 레거시(ai 로 마이그레이션됨)
}

interface AIConfig {
  provider: "gemini" | "openai" | "anthropic";
  keys: Record<Provider, string>;          // ⚠️ 평문 API 키
  models: Partial<Record<Provider, string>>;
}
```

**동기화 판단:**
- `typography`, `keymap`, `customPresets`, `reading` → 사용자 취향. 동기화하면 UX 좋음(선택).
- `fonts` → base64 폰트 데이터라 큼. 동기화하면 폰트 자체도 같이 가야 함(선택).
- `ai.keys` → **평문 API 키. 절대 다른 사용자에게 노출 금지. 동기화한다면 사용자 본인 계정 한정 + 전송/저장 암호화 필수.** 단순함을 원하면 키는 동기화 제외(기기마다 입력)를 권장.
- `pythonPath` → **동기화 금지**(기기 로컬 경로).

---

## 6. `library.json` (폴더 정리 메타)

```ts
{
  folders: { id: string; name: string; parentId: string | null }[],   // 중첩 폴더 트리
  docs: Record<doc_id, { folder?: string | null; title?: string }>    // 문서 → 폴더 배정 + 표시 제목 오버라이드
}
```
비어 있으면 `{ folders: [], docs: {} }`. 동기화하면 라이브러리 구조가 기기 간 일치해서 좋다(작고 충돌 적음).

---

## 7. `state.json` ★ 동기화의 심장 ★

문서별 사이드카. **사용자가 만든 모든 데이터**(하이라이트·메모·읽기상태)가 여기 모인다. `useAnnotations.ts` 가 단일 소유, 변경 시 300ms 디바운스 후 **부분 병합 저장**(`reading:update` 가 기존 키 보존하며 머지).

실측 전체 예시:
```json
{
  "last_read_at": "2026-06-29T04:55:05.016Z",
  "finished": false,
  "highlights": [ /* HighlightRule[] */ ],
  "notes": [ /* Note[] */ ]
}
```

### 7.1 읽기 상태
- `last_read_at: string|null` — ISO8601. 문서 열 때 갱신(`App.tsx:219`).
- `finished: boolean` — 완독 토글(`App.tsx:224`).
- ⚠️ **스크롤 위치는 저장하지 않는다.** `scrollTop`은 런타임 전용. (원하면 sync에 "이어읽기 위치"를 새 필드로 추가 검토.)

### 7.2 `HighlightRule` (형광펜) — `app/src/highlight/highlights.ts`
```ts
interface HighlightRule {
  id: string;                 // "h_" + base36 시각
  text: string;               // 정규화된 매칭 문자열(연속공백 1개·trim)
  color: "yellow"|"green"|"blue"|"pink"|"purple";
  style: "fill"|"underline";
  case_sensitive: boolean;
  whole_word: boolean;
  label: string | null;
  note: string | null;
  created_at: string;         // ISO8601
  scope?: "keyword"|"passage";// 미지정(레거시)=keyword
  occurrence?: number;        // passage 전용: 같은 텍스트의 0-기반 출현 인덱스
}
```
> **텍스트-앵커 방식**: 좌표가 아니라 "정규화된 텍스트 + (passage면) 몇 번째 출현"으로 위치를 잡는다. 그래서 타이포(리플로우)가 바뀌어도, **그리고 기기가 달라도** 같은 `document.json` 본문이면 동일하게 재현된다. → 동기화 시 좌표 변환 걱정이 없다. 그냥 객체를 옮기면 된다.

### 7.3 `Note` (메모) — `app/src/notes/notes.ts`
```ts
interface Note {
  id: string;          // "n_" + base36시각 + 랜덤
  quote: string;       // 선택한 원문(표시·앵커 원본)
  anchor: string;      // normalizeText(quote) — 매칭용
  body: string;        // 메모 내용
  created_at: string;  // ISO8601
  updated_at: string;  // ISO8601  ← 충돌해소에 활용 가능
}
```

### 7.4 동기화에 주는 함의
- 두 컬렉션 다 **`id`로 식별되는 객체 배열**이라, 동기화 단위를 "문서 통째"가 아니라 "**개별 highlight/note 항목**"으로 잡으면 충돌이 거의 없다(맥에서 A 추가, 아이패드에서 B 추가 → 합집합).
- `created_at`/`updated_at`이 있으니 **항목 단위 last-write-wins** 또는 tombstone 기반 삭제 동기화가 쉽다.
- `last_read_at`/`finished`는 스칼라라 단순 last-write-wins(가장 최근 타임스탬프 우선).
- ⚠️ 삭제 동기화 주의: 현재 모델엔 **tombstone(삭제 표식)이 없다.** 단순히 "현재 배열 전체를 덮어쓰기"로 동기화하면, 한쪽 삭제가 다른 쪽 추가로 되살아날 수 있다. 항목 단위 머지를 하려면 서버에 `deleted_at` 같은 소프트삭제 필드를 추가하는 걸 권장.

---

## 8. 데이터 흐름 (기기 역할)

```
┌────────── 맥 (Mac, Apple Silicon) ──────────┐
│  PDF 드롭 → MinerU 추출 → docs/<id>/ 생성    │   (추출은 맥 전용)
│  하이라이트/메모 생성·편집                    │
└──────────────────┬──────────────────────────┘
                   │ 업로드: 문서 번들(불변) + state(가변)
                   ▼
            ┌────────────┐
            │   서버      │  (object storage + DB + API)
            └────────────┘
                   ▲
                   │ 다운로드: 번들 + state,  업로드: 아이패드에서 만든 state 변경
┌────────── 아이패드 (iPad) ──────────────────┐
│  문서 읽기(리플로우 뷰어)                     │   (추출 불가 — 읽기/주석만)
│  하이라이트/메모 생성·편집 → 서버로 동기화     │
└─────────────────────────────────────────────┘
```

- **자산(번들)은 한 번 만들어지면 안 바뀜** → 업로드 1회, 이후 CDN/캐시 다운로드. ETag/`doc_id`로 캐시 무효화 거의 없음.
- **state는 자주 바뀜** → 폴링 또는 push로 양방향 동기화.

---

## 9. 권장 백엔드 설계

### 9.1 저장소 선택
- **객체 스토리지 (S3 호환: AWS S3 / Cloudflare R2 / MinIO)** ← 문서 번들(`document.json`, `source.pdf`, `pages/*`, `assets/*`). 키 prefix: `docs/<doc_id>/...`. 불변·대용량·CDN 친화.
- **관계형 DB (PostgreSQL 권장)** ← 메타데이터 + 사용자 생성 상태. 작고 자주 바뀌고 쿼리·머지가 필요.
  - 혼자 쓰는 1인 동기화로 가볍게 가려면 **SQLite + 파일동기(예: Litestream)** 도 가능하지만, 다기기 동시쓰기·향후 확장 고려하면 Postgres가 정석.
- 굳이 관리형 백엔드를 통째로 쓰고 싶다면 **Supabase**(Postgres + Storage + Auth + Realtime)나 **Firebase/Firestore + Storage** 가 이 데이터 모양(문서+상태+파일)에 잘 맞고 구현이 빠르다. 직접 굴리려면 **FastAPI/Node(Express·Hono) + Postgres + S3** 조합.

### 9.2 제안 관계형 스키마
```sql
-- 사용자(초기엔 본인 1명이라도 둬서 멀티기기/향후 확장 대비)
user(id, email, created_at)

-- 문서 메타 (번들 자체는 object storage)
document(
  doc_id TEXT PRIMARY KEY,        -- 콘텐츠 주소 id (§3)
  owner_id,
  content_hash TEXT,             -- PDF sha256 (재명명 견고성)
  title, authors, journal,
  page_count INT,
  bundle_prefix TEXT,            -- object storage prefix
  bundle_bytes BIGINT,
  created_at, updated_at
)

-- 읽기 상태 (문서×사용자 1행)
reading_state(
  doc_id, user_id,
  finished BOOL,
  last_read_at TIMESTAMPTZ,
  scroll_anchor TEXT NULL,       -- (신규) 이어읽기 위치를 넣고 싶다면
  updated_at TIMESTAMPTZ,        -- LWW용
  PRIMARY KEY(doc_id, user_id)
)

-- 하이라이트 (항목 단위 동기화 → 충돌 최소화)
highlight(
  id TEXT PRIMARY KEY,           -- 클라이언트 생성 id (h_...)
  doc_id, user_id,
  text, color, style,
  case_sensitive BOOL, whole_word BOOL,
  scope TEXT, occurrence INT,
  label TEXT, note TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ NULL    -- 소프트삭제(삭제 동기화용 tombstone)
)

-- 메모
note(
  id TEXT PRIMARY KEY,           -- n_...
  doc_id, user_id,
  quote, anchor, body,
  created_at, updated_at,
  deleted_at TIMESTAMPTZ NULL
)

-- 라이브러리 정리(작아서 통째 JSON 한 행으로 둬도 됨)
library(user_id PRIMARY KEY, folders JSONB, docs JSONB, updated_at)

-- 설정(동기화한다면; ai.keys 는 제외하거나 암호화)
settings(user_id PRIMARY KEY, data JSONB, updated_at)
```

### 9.3 제안 API 표면
```
POST   /documents                      # 번들 업로드 시작(메타 + presigned URL 발급)
PUT    {presigned}/docs/<id>/...        # 각 파일 object storage 직접 업로드
GET    /documents                       # 내 문서 목록(DocSummary[]) — since= 로 증분
GET    /documents/<doc_id>              # 메타 + 번들 다운로드 URL들
GET    /documents/<doc_id>/file/<path>  # 또는 presigned로 document.json/pages/assets 제공
DELETE /documents/<doc_id>

GET    /sync?since=<timestamp>          # 변경분 풀(highlights/notes/reading/library) 한 번에
POST   /sync                            # 변경분 푸시(배치 upsert + 삭제 tombstone)
# 또는 리소스별:
GET/PUT /documents/<doc_id>/state       # state.json 통째(간단) — 단순 LWW
PUT     /highlights  (배치 upsert)       # 항목 단위(견고) — 권장
PUT     /notes       (배치 upsert)
PUT     /reading-state/<doc_id>
GET/PUT /library
```
- **간단 버전**: `state.json`을 통째로 GET/PUT + `updated_at` 비교 LWW. 구현 빠름, 동시편집 시 한쪽 손실 위험.
- **견고 버전**: highlight/note를 **항목 단위 upsert + soft delete**, `since` 기반 증분 동기화. 합집합 머지로 손실 없음. ← 다기기 쓸 거면 이쪽 권장.

### 9.4 동기화/충돌 정책
- 자산 번들: 불변 → 충돌 없음. `doc_id` 존재하면 업로드 skip(idempotent).
- 항목(highlight/note): id 단위. `updated_at` 큰 쪽 우선, `deleted_at` 있으면 삭제. 양쪽 신규는 합집합.
- 스칼라(finished/last_read_at): `updated_at`/타임스탬프 LWW.
- 오프라인 우선: 클라이언트는 로컬 파일을 진실로 두고, 온라인 되면 증분 push/pull. (Electron은 이미 로컬 파일 기반이라 자연스러움.)

### 9.5 인증
- 초기엔 본인 다기기 → **단일 사용자 토큰/OAuth(예: Apple Sign in, 또는 간단한 이메일 매직링크)** 면 충분. 위 스키마에 `user_id`만 박혀 있으면 멀티유저 확장은 나중에 자연스럽게 됨.

---

## 10. 구현 시 주의점 체크리스트

- [ ] **이미지 경로 매핑**: 뷰어는 `paper://<doc_id>/<상대경로>`로 자산을 로드한다(`main.ts` 보안 프로토콜). 아이패드/웹 클라이언트는 이 스킴을 서버 URL(또는 presigned URL)로 바꾸는 해석 계층이 필요. `document.json` 안의 `image`/`pages[].image` 는 전부 상대경로다.
- [ ] **`mineru/` 폴더는 업로드 제외**(디버그 중간물, 큼). `pages/`+`assets/`+`document.json`(+선택 `source.pdf`)만.
- [ ] **API 키 동기화 금지(권장)** 또는 강력 암호화. `settings.ai.keys`는 평문이다.
- [ ] **`pythonPath` 등 기기 로컬 설정 동기화 금지.**
- [ ] **삭제 동기화**: 현재 모델엔 tombstone이 없다. 항목 단위 머지를 하려면 `deleted_at` 도입 필수(없으면 삭제가 되살아남).
- [ ] **`content_hash`(PDF sha256) 별도 저장 권장**: doc_id의 slug 부분이 파일명 의존이라, 진짜 동일성은 해시로 판단.
- [ ] **추출은 맥 전용**: 아이패드 클라이언트엔 추출 UI를 두지 말고 "맥에서 추가됨" 읽기 소비 모델로.
- [ ] **이어읽기 위치**: 지금은 스크롤 위치 미저장. 기기 간 "이어읽기"를 원하면 `state.json`에 앵커(예: 화면 상단 blockId)를 새로 저장하는 작업이 앱 양쪽에 필요.
- [ ] **증분 동기화 키**: 모든 동기화 리소스에 `updated_at`을 두고 `?since=` 풀을 지원하면 트래픽이 작아짐.

---

## 11. 빠른 참조 — 파일 위치

| 알고 싶은 것 | 파일 |
|---|---|
| 모든 파일 IO·IPC·저장 경로 | `app/electron/main.ts` |
| 렌더러에 노출된 API 표면(데이터 접근 계약) | `app/electron/preload.ts` |
| `document.json` 타입 | `app/src/types.ts` |
| `state.json` 소유·저장 로직 | `app/src/annotations/useAnnotations.ts` |
| 하이라이트 스키마·앵커링 | `app/src/highlight/highlights.ts` |
| 메모 스키마·앵커링 | `app/src/notes/notes.ts` |
| 전역 설정/AI 키 | `app/src/store/useStore.ts`, `app/src/ai/ai.ts` |
| `doc_id` 생성 | `pipeline/extract.py` (`make_doc_id`) |
| `document.json` 빌드 | `pipeline/build_document.py` |
| 명세 / 진행계획 | `PAPER_READER_SPEC.md`, `PLAN.md` |
```
> 참고: 원본 명세(`PAPER_READER_SPEC.md` line 33)는 "클라우드 동기화·멀티유저·모바일"을 **비목표**로 적어 두었다. 즉 이 백엔드 작업은 기존 범위를 넘어선 신규 확장이며, 위 데이터 모델은 그에 맞게 새로 설계해야 한다.
</content>
</invoke>
