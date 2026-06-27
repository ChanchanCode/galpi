# 작업 로그

[2026-06-27 18:30] 배포 — macOS .dmg + 친구 셋업 + 수동 업데이트 (Phase 6)

한 일:
- electron-builder: arm64 dmg 타깃 + extraResources 로 pipeline/*.py·*.sh·requirements 동봉,
  publish=github(ChanchanCode/galpi), artifactName. 검증: `--mac --dir` 로 .app 생성(245MB,
  모델/venv 미포함) + Resources/pipeline 에 7파일 동봉 확인.
- main.ts: 패키징 환경 대비 추출 엔진 경로 분리 — pipelineScriptsDir()=resourcesPath/pipeline
  (dev=repo/pipeline), resolvePython()=env PAPER_PYTHON→settings.pythonPath→기본 pyenv
  (~/Library/Application Support/PaperReader/pyenv)→dev venv. 기존 중복 settingsPath 제거.
  extract 핸들러가 이를 사용 + 친구용 에러문구.
- 신규 IPC: pipeline:status / pipeline:pickPython(파이썬 직접 지정 저장) / app:version /
  app:checkUpdate(GitHub 최신 릴리스 태그 vs 현재버전, semver-lite 비교) / app:openExternal.
  preload 노출 + 설정창 "추출 엔진·업데이트" 섹션(버전·업데이트 확인·엔진 상태·Python 지정).
- pipeline/setup-mac.sh: 친구가 한 번 실행 → Python3.12(없으면 brew)+venv+MinerU/PyMuPDF 를
  앱 기본 위치에 설치. DISTRIBUTE.md(빌드/릴리스/Gatekeeper 우회/설치/업데이트 가이드) +
  .github/workflows/release.yml(태그 v* → macos-14 러너 빌드 → 릴리스 업로드, 미서명).

결정과 이유(사용자 선택):
- 무료·수동 업데이트: 자동 업데이트는 Squirrel.Mac 이 코드서명 요구 → Apple Dev $99/년 필요라
  보류. 대신 앱 내 "업데이트 확인"=GitHub 최신태그 비교 + 다운로드 페이지 열기.
- 친구도 추출 필요 → 무거운 venv/모델(~5GB)은 .dmg 에 안 넣고(스크립트만 동봉), 셋업 스크립트로
  기본 위치 설치 → 앱이 그 위치를 자동 탐색. 못 찾으면 설정에서 Python 직접 지정.
- 번역은 Gemini 클라우드라 배포 영향 없음(키만).

막힌 점 / 다음:
- 친구가 다운로드/업데이트 확인하려면 릴리스 public 필요(현재 private) → DISTRIBUTE.md 에 명시.
  실제 타 머신 설치·추출 e2e 는 미검증(빌드·번들까지). 진짜 자동 업데이트는 서명 도입 시 추가 가능.

[2026-06-27 17:55] 점프 후 "원래 위치로" 버튼 + Cmd+Z 되돌리기 (사용자 요청)

한 일:
- nav/jump.ts: 중앙 점프 모듈. jumpToElement/jumpWith 가 점프 직전 .reader-scroll scrollTop 을
  history 스택에 push 후 스크롤, 리스너에 도착 element 통지. undoJump()=스택 pop 후 복귀(버튼·Cmd+Z
  공용), resetJumpHistory()=문서 전환 시 초기화.
- nav/JumpBackButton.tsx: 점프 통지 받으면 "↩ 원래 위치" 떠움. IntersectionObserver(root=scroller)
  로 도착지 추적 — 일단 보인 뒤(seen) 화면을 완전히 벗어나면 버튼 숨김. 클릭=undoJump.
- App: <JumpBackButton/> 렌더, Cmd/Ctrl+Z keydown→undoJump(입력창 제외, 도착지 화면밖이어도 동작),
  doc.doc_id 변경 시 resetJumpHistory.
- 점프 소스 3곳을 모듈 경유로 전환: RefLink(상호참조)·SectionRail(목차)·HighlightLayer(형광펜).

결정과 이유:
- "화면을 완전히 벗어나면 버튼 사라지게"는 도착지(target) 기준으로 해석 — 점프하면 항상 버튼이 뜨고,
  도착지에서 스크롤로 벗어나면 숨김, 그 경우 Cmd+Z 가 fallback. (원래위치 기준이면 먼 점프 시 버튼이
  아예 안 떠 무용지물이라 배제.)
- 히스토리는 스택이라 A→B→C 후 Cmd+Z 연타로 B→A 순차 복귀. FindBar 연속 이동은 히스토리 제외.

막힌 점 / 다음:
- tsc/vite 통과. IO seen-플래그로 부드러운 스크롤 도중 조기 숨김 방지. 실앱 검증 권장.

[2026-06-27 17:30] 상호참조 호버/점프 + Bionic + 문장 줄바꿈 (사용자 요청)

한 일:
- 상호참조 일반화: render/figures→crossrefs.ts. 그림/표/수식(\tag)/정리·명제(Proposition,
  Lemma, Theorem, Corollary, Definition, Assumption, Remark, Conjecture) 인덱싱. 본문
  "Figure N/Eq.(N)/Proposition N" 감지(정의블록 자기링크는 `(?!\s*\()` 로 제외).
  RefLink(FigureRef 대체): 1초 호버→프리뷰 팝오버(수식=Formula·정리=본문 inline math·
  그림=썸네일+라이트박스), 클릭→블록 이동+도착 .ref-target-flash 강조. 팝오버는
  createPortal(body)로 포커스모드 opacity 회피.
- Bionic Reading: render/reading.tsx bionicNodes(단어 앞부분 굵게, 길이비례 boldLen).
- 문장 끝 줄바꿈: splitSentences — .?! 만, 소수점(d.d)·약어(ABBR set)·단일 이니셜 제외 +
  "다음이 공백+대문자/숫자/여는기호"일 때만 끊어 과분할 방지. 문장마다 <br>.
- 둘 다 ReadingContext(전역 토글)로 RichText 평문 조각에만 적용. store.reading 영속 +
  keymap 액션 bionic(B)/sentenceBreak(L) + 설정창 "읽기 보조" 토글.

결정과 이유:
- 스크린샷의 파란 참조(Eq.(6)·Proposition 1·(B.8))는 bibliographic citation 이 아니라
  내부 상호참조 → 그림참조 시스템을 일반화해 견고하게 해결(데이터 명시적: 정의블록 괄호제목,
  수식 \tag). 참고문헌(저자-연도) 인용은 별개 문제로 계속 보류.
- 문장분할은 사용자 우려(과분할)대로 보수적: 끊는 조건을 "다음 문장이 대문자/숫자로 시작"으로
  강제 → U.S./e.g./Fig./소수점/이니셜 등 대부분 안전.
- 읽기 토글은 RichText 빠른경로(단일 텍스트노드=하이라이트/검색 유리)를 OFF일 때 보존,
  ON이면 다중노드(트레이드오프).

인사이트:
- 실데이터(Sautner) 검증: 인덱스 56키(statement15/eq35/figure6), 본문 eq언급 41/42·
  정리언급 35/36 해결, 부록 eq:B.8/B.9 포함, 거짓양성 0.
- RefLink 가 RichText 를 import 하지 않게(순환 회피) 프리뷰는 자체 previewNodes(math만).

막힌 점 / 다음:
- tsc/vite 통과. 한계: 복합참조 둘째항(and (B.9))·로마숫자 표·Section 링크 미지원.
  실앱 시각 검증(호버 프리뷰·점프·Bionic·문장 줄바꿈 오분할 여부) 사용자 권장.

[2026-06-27 16:45] 가독성 강화 묶음 (Phase 7 일부) + 방향키 lerp 보정

한 일:
- 방향키 페이지 이동 lerp 계수 0.34→0.24(~0.4초)로 약간 느리게(사용자: 과하게 빠름).
- 그림/표 인라인 참조(§11-5): render/figures.ts(캡션 선두번호로 figure/table 인덱싱 +
  본문 "Figure N/Fig. N/Table N" 감지) → RichText 가 인덱스에 해결되는 언급만 FigureRef 로
  래핑. FigureRef: 클릭 시 썸네일+캡션 팝오버, 썸네일 클릭→라이트박스, "본문 위치로" 점프.
  포커스 모드의 ancestor opacity 에 안 가리게 팝오버/라이트박스는 createPortal(document.body).
- 포커스 모드(§11-9): focus/FocusMode.tsx — IntersectionObserver(root=reader-scroll,
  rootMargin -42%) 중앙 띠에 걸친 블록만 .is-focus, 나머지 opacity 0.26. 바 토글(◎)+단축키 F
  (keymap 에 focus 액션 추가).
- 다크/세피아 수식 대비(§11-12): .katex{color:var(--fg)}.

결정과 이유:
- 인용·참고문헌 프리뷰(원래 최우선)는 보류: 실데이터에 reference 타입 블록 0개 +
  저자-연도식 인용이라 안정 매칭 난해 → 실논문 반복검증 동반 별도 진행으로 미룸.
- 대신 데이터가 깨끗한(캡션 "Figure N" 명시) 그림 참조를 헤드라인으로. node 검증:
  Carhart 본문 그림언급 4/4 해결, 거짓양성 0(표는 로마숫자/빈캡션이라 비매칭).
- 아웃라인/진행률은 앞서 목차 패널+위치 눈금으로 이미 충족 → 스티키 헤더만 잔여.

인사이트:
- ancestor 의 opacity(<1)는 position:fixed 자손도 합성으로 흐리게 만든다 → 포커스 모드와
  팝오버 공존 위해 포털 필수. FootnoteRef 도 동일 잠재이슈(소규모라 보류).
- RichText 빠른경로(텍스트노드 1개) 유지 위해 hasResolvableMention 으로 언급 있는 문단만
  다중노드 분해(하이라이트/검색 영향 최소화).

막힌 점 / 다음:
- tsc/vite 빌드 통과. 실앱 시각 검증(그림 팝오버/라이트박스/포커스 디밍/다크 수식) 권장.
- 다음 후보: 인용·참고문헌 프리뷰(휴리스틱), 스티키 섹션 헤더.

[2026-06-27 16:05] 설정창 재정비 + 방향키 페이지 이동 (사용자 피드백)

한 일:
- 좌/우 방향키로 한 화면(90%, 10% 겹침)씩 부드럽게 이동(App). ↑/↓ 기본 미세 스크롤 유지.
- '집중' 기본 프리셋을 사용자 공유 코드값으로 교체(typography.ts): 폭860·줄간격2.25·문단1.8·
  20px·세피아 등.
- 본문 폭 ↔ 여백 통일: Typography 에서 pagePadding 제거 → 패딩은 styles.css 고정값(48px)으로
  일원화, 사용자는 "본문 폭"만 조절. toCssVars 에서 --page-padding 미출력.
- 프리셋 UI 정리: 기본/사용자 구분 폐지 → "프리셋" 한 줄 칩으로 통합(클릭 적용). 저장 행은
  유지, 공유·코드 불러오기·사용자프리셋 관리(삭제)는 <details> 접이식으로 한 단계 더 감춤.
- 설정창 폭 340→560px(max 92vw), 2단 그리드. 슬라이더를 [−][슬라이더][＋] 조합으로 교체
  (드래그+증감 둘 다, 썸 20px). 단축키 창은 420px 유지.

결정과 이유:
- 사용자 피드백: 설정창이 좌우로 좁고 슬라이더 미세조정이 불편 → 넓힌 모달 + 긴 슬라이더 +
  증감 버튼(정밀). 본문폭/여백이 사실상 같은 기능 → 하나로. 프리셋/공유 UI가 지저분 → 통합 +
  공유는 접이식으로 깊게.
- pagePadding 은 타입에서 제거하되 settings.json 기존값/공유코드값은 sanitize 가 자동 무시
  (DEFAULT 키 기준), --page-padding 은 :root 상수로 항상 48px.

막힌 점 / 다음:
- tsc/vite 빌드 통과. 실앱에서 설정창 레이아웃·집중 프리셋 모양·방향키 이동감 사용자 확인 권장.

[2026-06-27 15:10] 단축키 UX 후속 보정 3건 (사용자 피드백)

한 일:
- 형광펜 선택 색 가림 해결: `::selection` 파란 배경이 CSS Custom Highlight 위에 그려져 색을
  가리던 문제 → 형광펜 적용 직후에만 `body[data-hl-dim="on"] .reader-content ::selection
  { background: transparent }`. 선택 자체는 유지(연속 탭 색순환 가능), 다음 드래그/클릭
  (mousedown) 또는 선택 변경(selectionchange)에 자동 복원. HighlightLayer 에 setDim/dimmedFor.
- 섹션 이동 막대 사용성 개선: 작고 클릭/호버 어렵던 눈금 → (1) 위치 미니맵(스크롤바 위, 표시
  전용) + (2) 스크롤바 왼쪽 30px 넓은 호버 영역 → 펼쳐지는 목차 패널(큰 행, 레벨 들여쓰기,
  현재 ▸ 강조, 클릭 점프) + (3) 항상 표시되는 현재-섹션 칩. SectionRail expanded 상태 +
  enter/leave(180ms 유예).
- 원본 대조를 자유 뷰어 창으로: 고정 loupe 팝오버 → 헤더 드래그 이동·우하단 모서리 크기조절·
  휠 줌(커서 기준)·드래그 팬·＋/−/맞춤 버튼. 바깥 클릭 닫힘 제거(원문↔reflow 나란히 보며 본문
  만져도 유지), ✕/Esc 로만 닫음. SourcePeek CropPopover 재작성(WinState/ViewState, pointer 드래그).

결정과 이유:
- 사용자 요청: 형광펜 색이 선택 배경에 가려 안 보임 → 선택 해제 없이 배경만 숨김.
- 눈금 클릭이 어렵다 → 클릭은 넓은 목차 패널에서, 눈금은 위치 표시로 역할 분리.
- "일반 뷰어처럼" → transform(translate+scale) 기반 줌/팬, pointermove/up 창 리스너로 드래그.

막힌 점 / 다음:
- tsc/vite 빌드 통과. 실앱에서 드래그/줌/팬 감도(휠 계수 0.0015, 줌 범위 0.1~16×) 사용자 확인 권장.

[2026-06-27 14:17] 단축키 중심 UX 묶음 — 검색·키맵·형광펜 단축키화·원문대조키·섹션막대·프리셋 공유

한 일:
- 텍스트 검색(⌘F): `app/src/search/search.ts`(CSS Custom Highlight, 형광펜과 다른 키
  `search-hit`/`search-current` 라 비간섭) + `app/src/search/FindBar.tsx`(우상단 고정 바,
  Enter/⇧Enter 이동, 대소문자 토글, Esc 닫기, 선택 텍스트 초기질의). 🔎 버튼은 커스텀
  이벤트 `galpi:find-open` 으로 바 열기.
- 중앙 키맵 `app/src/keys/keymap.ts`: ActionId(search/highlight/translate/sourcePeek/sections),
  `eventToCombo`/`matchCombo`(e.code 기반 → Alt+문자 데드키·레이아웃 회피), Mod=mac⌘/그외 Ctrl,
  `displayCombo`. 전역 settings 영속(useStore.keymap). 단축키 설정 창 `keys/ShortcutsPanel.tsx`
  (키 녹화 재바인딩, 중복 표시).
- 형광펜 단축키화 `highlight/HighlightLayer.tsx` 재작성: 선택 미니 툴바 제거 → 선택 후 키
  탭=색 순환(노랑→초록→파랑→분홍→보라→해제)·꾹(450ms)=제거. keydown 타이머+keyup 로 탭/홀드
  판별, 선택 유지로 연속 탭. 결과는 하단 중앙 알약(`.hl-status`). 관리 패널(🖊)은 유지.
- 원문 대조 단축키(기본 G) `sourcepeek/SourcePeek.tsx`: 선택이 본문 안이면 그 블록, 아니면
  화면 세로 중앙 블록 → 기존 crop 팝오버 재사용(검사 모드 없이 즉시).
- 섹션 이동 막대 `sections/SectionRail.tsx`: 스크롤 우측 16px 레일, heading(.blk-heading)
  오프셋 측정 → 눈금 위치, 현재 섹션 강조(scrollTop), 클릭 점프, 현재 위치 라인. 레일
  pointer-events:none + 눈금만 auto → 눈금 사이 스크롤바 사용 가능. 라벨은 hover 시 여백에만.
- 사용자 프리셋 `presets/share.ts` + TypographyPanel UI: 현재 타이포 저장, 목록 적용/삭제,
  `galpi-preset-v1:`+base64(UTF-8) 공유 코드 클립보드 복사, 붙여넣기 불러오기.
- 번역(SelectionTranslate)도 키맵 바인딩 사용으로 전환.

결정과 이유:
- 사용자 요청: text 위에 hover UI 금지 → 형광펜 선택 툴바 제거, 모든 신규 기능을 단축키 +
  화면 가장자리/하단 UI 로. 검색 바도 우상단 고정.
- 키 매칭은 e.code 기반(`baseKey`): mac 에서 Alt+문자가 데드키(©, ∆ 등)로 바뀌어 e.key 가
  깨지는 문제 회피. 형광펜 탭/홀드는 `matchCombo`(누름) + 글자키 keyup(종료)로 조합키도 지원.
- 공유 프리셋 범위는 사용자 선택으로 "타이포만"(단축키·형광펜색 제외). share.ts 는 알려진
  타이포 키만 통과(`sanitizeTypography`)시켜 외부 코드 신뢰 방지.
- 키맵/프리셋은 기존 settings:save/load(임의 JSON)에 그대로 얹어 main.ts 변경 0.

인사이트:
- 검색·형광펜이 같은 CSS Custom Highlight API 를 쓰지만 등록 키가 달라 충돌 없음.
  applyHighlights 는 자기 키(OUR_KEYS)만 삭제하므로 검색 키 보존.
- `presets/share.ts` 디코드는 PREFIX 앞뒤 잡텍스트(메신저 래퍼 등) 관대 처리 +
  base64 뒤 비-base64 문자 절단. node 라운드트립으로 한글·이모지·래퍼·garbage 케이스 확인.
- SectionRail 측정은 doc/blockCount/typography 변경 + resize + ResizeObserver 로 재계산,
  스크롤은 rAF 스로틀.

막힌 점 / 다음:
- tsc/vite 빌드 통과. 실앱 시각 검증(검색 이동·형광펜 탭/홀드·섹션 막대·프리셋 공유)은
  사용자 확인 권장 — Electron GUI 자동 구동은 화면 점유 우려로 보류.

[2026-06-26 16:55] Phase 5 — 키워드 형광펜 구현 완료 (실앱 시각 검증)

한 일:
- `app/src/highlight/highlights.ts` 신규: CSS Custom Highlight API 매칭 엔진.
  텍스트 노드 순회 → 정규화(공백 1개) → 규칙별 정규식(whole_word=Unicode 경계,
  case 옵션, 공백은 `\s+` 로 개행 흡수)로 Range 생성 → 색+스타일별 버킷 → CSS.highlights.set.
  KaTeX 내부 제외. firstMatchRange(점프), clearHighlights(문서 닫기).
- `app/src/highlight/HighlightLayer.tsx` 신규: 선택 미니 툴바(5색) + 관리 패널 + 엔진 배선.
  드래그/더블클릭 선택 → 툴바 색 클릭 → 동일 텍스트 전부 칠. 같은 색=토글 해제,
  다른 색=변경, 같은 텍스트 재선택=기존 규칙 갱신(중복 방지). 패널: 목록·출현수·
  색 변경·채움/밑줄·라벨·점프·삭제.
- App.tsx 에 🖊 토글 버튼·`<HighlightLayer>` 배선. styles.css 에 `::highlight(...)` 팔레트
  (테마별 조정)·툴바·패널 스타일. reader-root position:relative, bar z-index 45(패널 40 위).
- 영속화: 문서별 state.json `highlights[]` (reading:update 병합·디바운스 300ms).

결정과 이유:
- whole_word 기본 true(스펙 §8.2 일치): "risk" 선택이 "risky" 를 칠하지 않게.
- 매칭은 "블록 내 단일 텍스트 노드" 단위 — 텍스트 노드 가로지르는(인라인 수식 등)
  매칭은 MVP 제외(§8 line 380 명시 한계). 실제 본문 문단은 단일 텍스트 노드라 충분.
- 번역(SelectionTranslate)은 선택 자동팝업 없이 T키/우클릭 유지 → 형광펜 툴바와 충돌 없음
  (앞서 사용자가 이를 의도해 번역 자동팝업 제거해둠).

인사이트:
- CSS Custom Highlight 는 Range(텍스트노드+오프셋)에 묶여 reflow(타이포=순수 CSS)에
  자동 추종 → §8 요구("줄간격 바꿔도 따라옴")가 구조적으로 보장됨.
- 실앱 검증: Carhart 논문 "factors" 선택→노랑, 패널 출현수 13(전 26p 일괄) 표시.
  Source Peek 도 함께 검증 — 추상 블록 클릭→원본 p.1 정확 크롭 팝오버.
- 매칭 정규식 단위테스트 4/4(구절·단어경계·대소문자·부분일치) 통과.

막힌 점 / 다음:
- 검증 중 detached DevTools 창이 가끔 frontmost 를 가로채 클릭 실패 → open_application
  으로 Electron 재포커스 후 진행. (dev 모드 openDevTools 부작용, 기능과 무관)
- 다음: Phase 6(패키징 §13-6: electron-builder .app, app.getPath 경로 추상화, 라이브러리 뷰).

[2026-06-26 16:31] Phase 4 — 원본 대조 Source Peek 구현 완료

한 일:
- `app/src/sourcepeek/SourcePeek.tsx` 신규: 검사 모드 + bbox crop 팝오버(loupe) + 디버그 오버레이.
- 검사 모드 진입 2경로 — 리더 바 🔍 토글(고정) / ⌥(Option) 누른 채 클릭(일시).
  `body[data-inspect="on"]` 표식 → CSS 로 커서 돋보기 + 블록 호버 아웃라인.
- crop: 페이지 PNG(`paper://`)를 background-image + size/position 으로 클라이언트 crop(§9.2).
  작은 블록 최대 3× 확대, 큰 블록은 화면 맞춤 축소, PAD 6pt 여백. Esc/바깥 클릭 닫힘.
- 디버그 오버레이(Alt+Shift+D): 페이지 위 전 블록 bbox 박스(타입별 색) + 페이지 네비.
- App.tsx 에 🔍 토글 버튼·`<SourcePeek>` 배선, styles.css 에 peek-* 스타일 추가.

결정과 이유:
- 좌표 변환 y 뒤집기 **없음**으로 확정. bbox 는 PDF point·좌상단 원점(fitz),
  페이지 PNG 도 좌상단 원점 → 축별 균일 스케일 `image_px/size_pt`(=dpi/72)만 적용.
  Phase 1 캘리브레이션과 일치, 1512/544.18 ≈ 2.778 = 200/72 로 재확인.
- 검사 모드를 hold-⌥ 외에 🔍 고정 토글도 둔 이유: Option+클릭은 발견성이 낮아
  버튼으로 노출. 두 경로 병행.
- 팝오버는 클릭 좌표 옆에 배치 후 뷰포트 클램프(SelectionTranslate 패턴 답습).

인사이트:
- crop 좌표 정합을 데이터로 검증: 5개 문서 bbox 블록 1125개 전부 컴포넌트와
  동일 변환식으로 페이지 픽셀 범위 내(out-of-bounds 0). 좌표계 가정 옳음.
- HMR 동작 중이라 실행 중인 dev 인스턴스에 변경 즉시 반영됨(포트 5123 점유).

막힌 점 / 다음:
- 시각 검증은 computer-use 접근 권한 다이얼로그 미응답으로 미완 — ⌥+클릭 또는
  Alt+Shift+D 디버그 오버레이로 사용자 직접 확인 권장.
- 다음: Phase 5(키워드 형광펜 §8, CSS Custom Highlight API, reflow 후 유지·영구 저장).
