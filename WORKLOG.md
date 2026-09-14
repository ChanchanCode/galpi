# 작업 로그

[2026-09-14 00:30] 0.2.0 — AI 채팅 패널 · 핵심 요약 · 드롭 자동 번역/요약 · 선택 툴바 · 원본 텍스트층 · 계정/사용량 · 자동 업데이트

한 일:
- **AI 채팅**(⌘L): 우측 도킹/좌측/앱 내 플로팅, 폭·크기 드래그. 문서별 여러 세션(docs/<id>/ai/chats). 모델 선택(agy models 동적 목록 + API 키). 문맥 칩 전문/요약/없음. Markdown+KaTeX, 인용은 쪽 번호 칩(p.12–13) — 클릭 시 본문 점프.
- 첨부: 붙여넣기·드래그·그림 우클릭·⌥+드래그 영역 캡처. agy 는 전용 에이전트 galpi-chat(send_message+view_file) + --add-dir docs.
- **핵심 요약 탭**(summary.json), 추천 질문 칩. 드롭으로 추가하면 추출 후 **번역→요약 자동**(설정에서 끔).
- **선택 툴바**(설명·형광펜·번역·메모·인용·AI에게) — 예전 "본문 위 hover UI 금지"를 사용자가 이 기능에 한해 뒤집음. 읽기 탭에서 끌 수 있다.
- 원본 모드 **텍스트층**(pages/page-N.text.json, repage.py --text-only 로 기존 문서 소급).
- 계정 전환·추가·로그인(그냥 받아쓰기와 같은 ~/.claude/.state/gemini-accounts), 5시간/주간 한도 바, 토큰 사용량.
- 번역 팝업 모델을 "빠름/정확" → 정확한 모델명 목록으로.
- 성능: 확대 확정을 CSS zoom → transform(레이아웃 0, 최대 프레임 300ms→36ms). 번역 컬럼 폭 드래그 DOM 직접 쓰기 + 읽기/쓰기 분리 + 보던 자리 보정(이동 0px). 번역 캐시 문서 열 때 선적재.
- paper:// 에서 docId 를 호스트 → 경로로(한글 파일명이 퓨니코드로 깨지던 것).
- **자동 업데이트**: 릴리스 zip 을 받아 번들 교체 → 재시작, 나중에면 종료 시 적용(미서명이라 electron-updater 불가). 0.1.13 사용자는 이번 한 번만 dmg 수동 설치.

인사이트:
- agy 1.2: `--add-dir` 만 주면 그 폴더 이미지를 권한 프롬프트 없이 view_file 로 읽는다. 상대경로를 주면 모델이 경로를 추측하며 100스텝 넘게 헛돈다 — 절대경로 필수.
- 실측: 채팅 1턴(전문 문맥) 입력 39k·출력 2.5k·6.6초, 요약 입력 23k·출력 1.7k·14.8초(gemini-3.8-flash-medium).
- CSS zoom 확정은 11k 노드 문서에서 레이아웃+페인트 2프레임(각 ~150ms). transform 은 will-change 없으면 멈춘 배율로 다시 래스터해 선명(4.2배 확인).
- agy-conversations.json 형식이 [{id, home}] 로 바뀜.

막힌 점 / 다음:
- 번역 켜기(T) 자체는 여전히 ~0.3초(수식·표 두 컬럼 배치 레이아웃). 폭 드래그를 놓는 순간 1회 ~170ms.
- REST(API 키) 경로 이미지 채팅은 실호출 미검증. 자동 업데이트의 실제 번들 교체는 0.2.0→다음 버전에서 첫 실측.

[2026-08-27 18:55] 옵션탭 정리 · 보기별 번역 타이포 · agy '다시 확인' 수정

한 일:
- **번역 타이포를 보기별로 분리.** 정리 모드(`trReflow*`)와 원본 모드(`tr*`)가 각자 크기·줄간격을
  갖는다. 정리 모드는 기본이 **원문 연동**(자물쇠로 해제) — 영문 옆 한글 밸런스를 매번 맞출 수 없다.
  패널 번역 탭을 `정리 모드` / `원본 모드` / 자간(공통) 세 묶음으로 나눴다.
- **AI 설정 탭 전면 축소.** 설명 문단 7개(약 900자) → **0개, 총 109자**. 라벨·값·버튼만 남기고
  부연은 전부 `title` 툴팁으로 뺐다. 한도 버킷 중복 표시 제거(Gemini 것만).
- **`다시 확인` 버튼 수정** — `agy:probe` 가 `probeAgy()` 를 직접 불러 결과를 캐시에 안 남겼다.
  값은 돌아오지만 바로 뒤 `ai:status` 가 다시 "아직 확인 전"을 줘서 버튼이 먹통으로 보였다.
  `agyHealth(true)` 로 바꿔 확인 결과가 저장되게 했다.
- 입력창·셀렉트가 테마를 안 따르고 흰 배경으로 뜨던 것 수정(`.ai-row` 에 `.ctrl` 과 같은 스타일 적용,
  옆 버튼과 높이 32px 로 맞춤).

인사이트:
- **`settingsCache` 때문에 settings.json 을 밖에서 고쳐도 앱이 안 읽는다.** 렌더러만 리로드해서는
  소용없고 앱을 통째로 재시작해야 한다. 이걸 모르고 한참 헤맸다 — 앞으로 설정 검증은 앱 재시작부터.
- 실측(재시작 후 확인): 연동 해제 시 정리 모드 12px/1.45 가 그대로 먹고(`.tr-col` 12px/17.4px),
  원문은 24px 유지, 원본 모드는 18px/2.35 로 따로 논다. 세 축이 독립.

막힌 점 / 다음:
- `Page.captureScreenshot` 이 응답 없을 때가 있다(창이 뒤에 있으면 렌더가 멈춘 듯). 검증은 DOM 측정으로.
- `prefix` 앵커 모드 실모델 비용 비교 여전히 미수행(P3 1순위).

[2026-08-27 18:20] 번역 컬럼 조판 — 원문과 크기 일치, 원문이 간격 양보, 표/수식 두 컬럼 정렬

한 일:
- 보기 A 의 번역 크기·줄간격을 **원문과 일치**시켰다(D37). 글꼴·자간은 번역 축 유지.
  타이포 패널의 번역 크기/줄간격 라벨을 `· 원본 모드` 로 바꿔 어디에 적용되는지 드러냄.
- 번역 카드의 섹션 제목에 원문과 같은 **위계**(레벨별 크기 + bold). `TrSource.level` 추가.
- **행 정렬 재작성(D38)** — 카드를 밀지 않고 **원문 블록에 `padding-bottom`** 을 넣어 행을 벌린다.
  자연 상태에서 한 번 재고 누적 이동량으로 한 번에 쓴다(되먹임 반복 없음).
  ResizeObserver 되먹임은 rAF 가드로 차단. 내보내기에서는 이 여백을 걷어낸다.
- **표·수식·그림을 두 컬럼 전체 기준 가운데 정렬(D39)** + 그 행의 번역탭 자리를 비운다.
  행 계산이 카드 없는 블록(`:scope > [data-block-id]` 전부)까지 보게 바꿔 카드가 표를 타고 넘지 않는다.

결정과 이유:
- 카드를 미는 방식(`Math.max(top, prevBottom+GAP)`)을 버렸다. 크기를 원문과 맞추자 한국어가
  영문보다 길어지는 일이 잦아졌고, 밀기 시작하면 정렬이 누적으로 어긋나 결국 겹쳤다.
  **원문이 자리를 내주는 쪽**이 사용자 요구("각 block이 딱 맞게 정렬돼야해")와도 맞는다.
- 래퍼가 아니라 `padding-bottom` 이라 `:scope > [data-block-id]` 가정(D20)이 그대로 산다.

인사이트:
- 실측: 카드 133개, **정렬 오차 최대 0.5px · 어긋난 카드 0 · 겹친 카드 0**, 여백을 받은 블록 104개.
- 표는 무대 폭 1496 중 좌 47 / 우 64 로 두 컬럼에 걸쳐 놓인다(차이는 무대 오른쪽 여백 18px).

- (추가) **버튼을 누르면 확대·이동이 초기화되던 것 수정(D40).** 원인이 둘이었다:
  ① `T` 는 열 때마다 `fit()` 을 걸어 배율을 덮었다 → `touched` 플래그를 두고 사용자가 한 번이라도
  직접 확대·이동했으면 자동 맞춤을 건너뛴다. ② 원본 모드 버튼은 `SourceView` 를 통째로 재마운트해
  그 안의 `useCanvas` 가 새로 생겼다 → 캔버스를 App 으로 올렸다. 이동은 DOM 직접 쓰기(D35)라
  노드가 새로 생기면 값이 사라지므로 렌더마다 transform 을 다시 붙인다.
  실측: 리플로우 2.87배 → T 눌러도 2.87배 유지. 원본 3.74배·이동 −823px → 보기 왕복 후에도 그대로.
  손 안 댄 문서에서는 자동 맞춤(0.976배)이 여전히 걸린다.

막힌 점 / 다음:
- `prefix` 앵커 모드 실모델 비용 비교 여전히 미수행(P3 1순위).

[2026-08-27 17:45] 번역 UI 사용자 피드백 반영 — 상단바 정리·팝업 개편·캔버스 안정화

한 일:
- **가독성**: 번역 기본값을 사용자가 맞춘 값으로(14px · 줄간격 2.30 · 자간 0). 읽기 보조
  '문장 줄바꿈'이 번역 컬럼에도 걸리게(`body[data-sentence-break] .tr-s{display:block}`).
  번역 카드에 **LaTeX 렌더링** 추가(`TrText`) — `$\alpha_{s}$` 가 그대로 노출되던 것.
  번역 패널 스크롤바를 얇고 연하게.
- **상단바**: 버튼 9개 → 7개. 목차·주석 버튼 제거(목차는 **제목 클릭**, 주석은 `I`).
  `역` → `T`, 돋보기 이모지 → SVG, 설정은 진짜 톱니바퀴로. `← 라이브러리` 두 줄 접힘 수정.
- **팝업**: 상시 코너 위젯 제거. `T` 는 컬럼을 켜고 끄고, **처음 번역할 때만** 팝업이 뜬다
  (백엔드·모델 빠름/정확·예상 소모·시작). 재번역은 카드 우클릭 → `재번역` / `전체 재번역`.
- **캔버스**: 보기 A 에도 팬/줌(보기 B 와 `useCanvas` 공유). 가로 이동을 state → **DOM 직접 쓰기**로
  바꿔 버벅임 제거. 이동 한계 60% → 12%. 트랙패드 핀치 감도 분리(휠 0.0022 / 핀치 0.012).
  두 손가락 가로 밀기 = 가로 이동. 배율 표시는 만진 뒤 1.5초만.
- **원본 모드**: 이름 변경(원본 지면 → 원본 모드). 번역 없이도 전환 가능.
  **호버 연결 추가** — 카드 ↔ 지면 블록 bbox 사각형 양방향(§7.4). 실측 상자 135개, 양방향 일치.
- Space 가 포커스된 버튼을 누르던 것 수정(캔버스 만지면 blur + Space 기본동작 차단).
- 논문 폭이 번역 컬럼 폭에 따라 줄어들던 것 수정 — 본문은 옵션 값 고정, 넘치면 캔버스로 민다.

결정과 이유:
- **가로 이동을 React state 에서 뺐다(D35).** 세로는 부드러운데 가로만 버벅인 이유가 이것이었다 —
  세로는 네이티브 스크롤이고, 가로는 `panX` state 라 프레임마다 카드 133개가 리렌더됐다.
  `panXRef` + rAF 합침 + `shiftRef.style.transform` 직접 쓰기로 바꿔 실측 115fps.
- **번역 컬럼을 여는 순간 맞춤 배율(D36).** 본문 폭을 고정하기로 한 이상(사용자 요구)
  본문 960 + 컬럼 550 이 창 1184 를 넘으면 컬럼이 잘린다. 여는 시점에만 배율로 줄인다 —
  손잡이를 끌 때마다 배율이 튀면 안 되므로 false→true 전이에서만 건다.

인사이트:
- **`width: max-content` 가 무대를 8,385px 로 부풀렸다(§2.15).** 본문 안 breakout 요소
  (`90vw` 표·수식)가 내재 크기 질의에서 통제 없이 커지고, 논문 폭 고정을 위해 `max-width:none` 을
  걸어 둬서 상한도 없었다. `justify-content:center` 가 그 8,385px 안에서 본문을 화면 밖으로 밀어
  "번역 켜면 화면이 빈다"로 나타났다. 무대 폭은 JS 로 계산해 인라인으로 준다.
- **훅을 고치면 HMR 이 "Rendered more hooks" 로 터진다.** 실제 버그가 아니라 마운트된 컴포넌트에
  훅이 추가된 것 — 하드 리로드하면 정상. 앞으로 훅 수정 뒤 검증은 `Page.reload` 부터.

막힌 점 / 다음:
- **세 손가락 드래그는 못 가른다.** macOS 가 그걸 일반 마우스 드래그로 합성해 보내서
  텍스트 선택과 구분할 방법이 없다. 두 손가락 가로 밀기로 우회했다.
- `prefix` 앵커 모드 실모델 비용 비교는 여전히 미수행(P3 1순위).

[2026-08-26 19:05] 번역 보기 사용자 피드백 6건 반영 — 가독성·조작 통일

한 일:
- 번역 기본값을 사용자가 직접 맞춘 값으로: **14px · 줄간격 2.30 · 자간 0** (기존 15/1.75).
- 헤더 버튼 `역` → **`T`**.
- 보기 A 폭 손잡이를 컬럼 오른쪽 → **두 패널 사이**로 옮기고 방향을 뒤집었다(왼쪽으로 끌면 번역이 넓어짐).
  보기 B 와 같은 자리·같은 방향이 됐다.
- 읽기 보조 **'문장 줄바꿈'이 번역 컬럼에도 적용**된다. `body[data-sentence-break]` 표식 한 줄 +
  `.tr-s { display: block }`. 번역 문장이 이미 span 으로 쪼개져 있어 이게 전부였다.
- 보기 B 가 **가운데 고정**이던 것을 자유 이동으로. 가로를 네이티브 스크롤에서 transform 이동으로 바꿨다.
- 보기 A 에도 **같은 팬/줌**을 붙였다. 팬/줌 로직을 `translate/useCanvas.ts` 훅으로 빼 두 보기가 공유한다.

결정과 이유:
- **§7.1 의 "캔버스 안 붙인다" 를 뒤집었다(D27).** 사용자 요청. 타이포 패널로 조판을 다시 하는 길은
  그대로 두되 확대·이동도 함께 된다.
- **이동 한계는 캔버스 폭의 60%(D28).** 무제한이면 "놓쳤다" 싶은 순간이 생기고, 콘텐츠 경계로 묶으면
  확대 상태에서 지면 가장자리를 못 본다. ⌘0 으로 배율·위치 동시 복귀.
- 배율 컨트롤은 **100% 일 때 안 띄운다** — 평소 읽을 때 화면에 뜬 UI 를 늘리지 않는다.

인사이트:
- **캔버스 `zoom` 이 걸리면 좌표계가 둘이 된다.** `getBoundingClientRect()` 는 화면px,
  `style.top`/`offsetHeight` 는 지역px 이다. 섞으면 카드 정렬이 배율만큼 어긋난다.
  무대 자신의 비(`getBoundingClientRect().width / offsetWidth`)로 나눠 환산했다 —
  프롭 드릴링 없이 어디서든 실제 배율을 얻는다. 374% 에서 정렬 오차 **0px** 확인.
- 폭 손잡이 드래그도 같은 이유로 이동량을 배율로 나눠야 손끝을 따라온다.

막힌 점 / 다음:
- 확대 시 `.blk-formula`·`.table-wrap` 의 `90vw` breakout 은 vw 가 zoom 을 안 타서 과하게 넓어진다.
  높은 배율에서만 보이는 미관 문제라 미룬다.

[2026-08-26 18:35] PLAN-AI P2 완료 — 보기 A/B·문장 호버 연결·타이포 통합, 실앱 종단 검증
                  + 견적 출력계수 오류·agy 로그인 교착 수정

한 일:
- **보기 A(리플로우 ‖ 번역)** `src/translate/TranslateColumn.tsx`. 카드를 절대 배치하고 대응 블록의
  화면 위치를 재서 top 을 직접 쓴다. D19(컬럼은 `.reader-content` 밖)·D20(그리드 래퍼 금지) 준수.
  읽기/쓰기를 두 패스로 갈라 카드 수만큼 강제 리플로우가 나던 걸 막았다.
- **보기 B(원본 ‖ 번역)** `src/translate/SourceView.tsx`. 지면 연속 스크롤 + 패닝 + 줌,
  쪽별 번역 카드(내부 스크롤·경계 잠금), `⤶` 이어짐 칩, IntersectionObserver 가상화.
- **문장 호버 연결** `src/translate/align.ts` — 양방향 동작 확인.
- **타이포 통합(§7.5)** 패널에 `원문 | 번역` 세그먼트 + 글꼴 연동 자물쇠. 공유축(본문 폭)은 별도 구역.
- **실앱 종단 검증(CDP 9222)** — 32쪽 133블록 전문 번역 26호출 전부 성공, 실소모 2.255%.
  중단→재개 무손실, 재실행 전량 캐시 적중, 벡터 쪽 477% 확대 선명.
- `pipeline/repage.py` 신설 — MinerU 재실행 없이 `pages[]` 만 다시 굽는다. 기존 5편에 소급 적용:
  ssrn 2편은 벡터 SVG 51/68쪽, 나머지 3편은 dpi 200→300/340/372.
- 테스트 9 → 11개(잘린 JSON 건지기 2개 추가).

결정과 이유:
- **견적 출력계수를 기능별로 갈랐다(D25).** 실측에서 입력은 1.02배로 정확한데 출력만 **2.41배**
  어긋났다. 원인은 D13 의 왕복 제약 — 모델이 한국어와 함께 원문 앵커를 되돌려주므로 출력이
  "한국어만" 견적의 배가 된다. §2.5 가 "1.7배" 라고 적어 뒀는데 견적 코드가 반영하지 않았다.
  출력 EWMA(`observeOut`)도 백엔드가 아니라 **기능** 키로 따로 돌린다.
  원장 행에 `EST_RULES_VERSION` 을 넣어 계수를 고친 뒤 옛 행으로 EWMA 를 복원하는 사고를 막았다.
  수정 후 재측정: 입력 1.02 · 출력 1.04 · 합계 오차 3.7%.
- **번역 글자 크기 기본값을 15px 로 했다(계획은 11px).** 18px 영문 옆 11px 한글은 짝이 안 맞는다.
  범위(8–22)는 계획대로라 한 번 드래그로 11 로 갈 수 있다. → 확인 필요.
- 각주·참고문헌은 번역 대상에서 뺐다. 각주는 접힌 `<details>` 로 끌려 나가 카드 붙일 자리가 없고,
  참고문헌은 값 대비 비용만 든다.
- 잘린 응답에서 **온전한 객체만 건진다(D26).** 통째로 버리면 그 배치 블록이 전부 날아간다
  (실측: 26배치 중 1개 실패 → 5블록 손실).

인사이트:
- **"진단하지 마라" 규칙이 교착을 만들었다.** §2.9 로 `agyHealth()` 가 probe 를 안 하게 했더니
  `loggedIn` 이 영원히 false 였고, `AgyBackend.stream()` 이 그걸 요구해 첫 턴을 스스로 막았다.
  턴이 안 나가니 `markLoggedIn()` 도 영영 안 불린다. P1 검증 때는 그 세션에서 이미 probe 를
  돌린 뒤라 안 걸렸다 — **통과한 통과 조건이 거짓이었다.**
  고침은 `agyUsable()`: 실제로 확인해서 미로그인이면 막고, 한 번도 확인 안 했으면 통과시킨 뒤
  **턴 자체의 auth 실패로 판정**한다. 상태를 요구하는 게이트가 어디에 또 있는지 전수 확인이 필요했다.
- **문장 호버는 오프셋으로 못 푼다.** 모델 span 은 `block.text` 기준인데 화면 DOM 은 그 문자열이
  아니다 — `$...$`는 KaTeX 노드로, `<sup>3</sup>`은 태그가 증발한 `3`으로, Bionic 은 단어 하나를
  텍스트 노드 둘로 쪼갠다. **단어 수열 그리디 정렬**로 우회했다(`align.ts`).
- `zoom` vs `transform` 분리가 실제로 동작함을 확인(D12): 제스처 중 `scale()`, 140ms 뒤 `zoom` 확정,
  `will-change: auto` 유지. 477% 에서 벡터 글자가 선명하다.

막힌 점 / 다음:
- `prefix` 앵커 모드는 구현·단위테스트만 됐고 **실모델 비용 미측정**. 출력계수 1.35 는 잠정값.
  여기서 출력이 절반이면 논문당 2.26% → 1.4% 대로 떨어진다. P3 우선순위.
- 내보내기(HTML)에 번역이 안 들어간다 — `exportHtml` 은 `.reader-content` 만 직렬화하는데
  번역 컬럼은 그 밖이다(D19의 대가).
- 3단 브레이크의 "실제가 견적의 1.5배 초과 시 자동 정지" 미구현. 지금은 견적이 맞아 급하지 않다.

[2026-08-26 18:05] PLAN-AI P2 절반 — 파이프라인·번역 코어 완료·검증, 렌더러(보기 A/B) 미착수
                  + 키체인 프롬프트 긴급 수정

한 일:
- **키체인 프롬프트 원인 규명·수정(사용자 신고).** `agy -p "/usage"` 한 번에 SecurityAgent 가
  뜨는 걸 실측(평소 5초 호출이 11.5초). agy 바이너리가 오늘 13:53 갱신돼 키체인 ACL 이
  무효화된 상태였고, 거기에 P1 에서 넣은 5분 주기 한도 폴러가 5분마다 창을 띄우고 있었다.
  → 주기 폴링 제거, 진단용 agy 호출 전면 제거(로그인 여부를 "실제 턴 성공" 으로 판정),
  prewarm 도 로그인 확인 뒤에만. 설정 화면에 "항상 허용" 안내 추가.
- 병렬 탐색 워크플로(6영역 + 완결성 비평가, 240 도구호출)로 렌더러·파이프라인·주석 계층 구조를 실측.
- H5 완료: `rasterize.py` 재작성. dpi 를 **하한**으로 바꾸고 스캔본은 원본 해상도에 맞춰 자동 상향,
  벡터 쪽은 SVG 도 함께 추출. 쪽별 `is_vector`/`svg` 를 `pages[]` 에 기록.
- 번역 코어 3종 신설: `ai/segment.ts`(마스킹·복원·앵커) · `ai/translationCache.ts`(텍스트 해시 캐시)
  · `ai/translateDoc.ts`(배치 스케줄러). `service.ts` 에서 `runAIJob()` 을 뽑아 IPC 와 배치가
  같은 통로를 쓰게 했다.
- **저장소 최초 테스트 도입** — `app/test/segment.test.mjs`, `npm test`(node:test, 의존성 0). 9개 통과.

결정과 이유:
- **PLAN 의 벡터 판정식 `get_fonts()>0 or get_text()>0` 을 폐기했다(D17).** 5편 중 3편을
  오분류한다 — OCR 텍스트 레이어가 얹힌 스캔본이 "벡터" 로 나온다. 실제로 SVG 를 뽑아
  `<image>` 유무로 판정한다. 진짜 벡터는 SSRN 2편뿐이고 gzip 30~54KB/쪽이다.
- **H5 상한을 원본 해상도까지 열지 않았다(D18).** mackinlay 30쪽이 200dpi 14MB / 460dpi 45MB.
  보기 B 는 패널 폭 ~700px 에서 400% 확대를 상정하니 긴 변 2800px 이면 충분하다 → 3400px 상한.
  덤으로 포맷을 갈랐다: 벡터 쪽 PNG, 스캔 쪽 JPEG q85(340dpi 기준 1.28MB → 0.83MB).
- **번역 컬럼을 `.reader-content` 밖에 둔다(D19).** 안에 넣으면 형광펜·메모·검색·내보내기 등
  `.reader-content` 를 querySelector 하는 **10개 모듈**이 한국어를 본문으로 먹는다.
  `::highlight()` CSS 도 전부 비스코프라 막을 방법이 없다.
- **행 정렬은 그리드 래퍼가 아니라 JS 측정(D20).** 래퍼를 넣는 순간 `:scope > [data-block-id]`
  가정이 `FocusMode.tsx:78`·`styles.css:798`·`export/focus-runtime.js:85` 세 곳에서 죽고,
  내보낸 HTML 까지 같이 깨진다.
- **파이프라인 텍스트 수정은 P2 밖으로 뺐다(D24).** footer 오분류·list 개행 소실·표/그림 캡션
  소실이 실재하지만, 고치면 블록 id(읽기 순서 인덱스)가 전부 밀려 기존 `state.json` 의
  형광펜·메모·수식편집이 깨진다. 별도 마이그레이션 건이다.
- 배치 동시성을 1로 고정했다. 큐 한도가 2 이므로 한 칸을 항상 선택 번역에 비워 둔다.
  큐에 우선순위를 넣어 선택 번역이 대기 중인 배치를 앞지르게 했다.

인사이트:
- **완결성 비평가가 내 코드의 실제 버그를 잡았다.** `segment.ts` 의 인라인 수식 정규식
  `\$[^$\n]+?\$` 이 파이프라인(`build_document.py:38`)·렌더러(`RichText.tsx:16`)의
  `(?<!\\)\$(.+?)(?<!\\)\$` 와 달라 이스케이프된 `\$` 를 인식 못 했다. 실데이터
  fama1992 b0125 에서 산문 79자를 수식으로 마스킹하고 진짜 수식은 노출했다. 셋을 한 패턴으로 통일(D22).
- **테스트가 두 번째 버그를 잡았다.** `toOriginal()` 이 조각 범위를 양끝 포함으로 봐서 경계
  인덱스가 앞 조각에 먼저 걸렸다 → **수식 바로 뒤 문장의 시작 좌표가 그 수식 안으로 밀린다.**
  반열린 구간(start 는 [s,e), end 는 (s,e])으로 고쳐 해결. 이건 눈으로는 절대 못 잡을 종류다.
- PLAN 이 P4 로 예고한 "규칙별 전체 TreeWalker 순회가 터진다" 는 **틀렸다.** `highlights.ts:113`
  이 walker 를 1개만 만들고 그 안에서 규칙을 순회한다 — O(T×R) exec, DOM 순회는 1회.
- PLAN §7.3 의 `--g-fg`/`--g-bg` 는 존재하지 않는 변수다. 실제는 `--bg --fg --muted --rule
  --accent --scrollbar-thumb` (`styles.css:16-18`, `<body data-theme>`). 그대로 썼으면
  SVG 가 dark 테마에서 안 보였다.
- 한 문서 안에서 페이지 크기가 섞인다(mackinlay 516×720 27쪽 + 595×792 3쪽). 보기 B 오프셋을
  "문서당 종횡비 하나" 로 누적하면 28쪽부터 어긋난다.
- SVG 의 `<use data-text="2">` 로 글리프마다 원문 글자가 실려 온다. 문장 단위 bbox 의 잠재 소스다.

막힌 점 / 다음:
- **배치 번역을 실모델로 종단 검증하지 못했다.** IPC·타입·캐시·스케줄러는 다 배선됐지만
  모델이 `translate.blocks` JSON 형식을 실제로 지키는지, 커버리지가 몇 %인지 미확인.
  CDP 로 큰 페이로드를 밀어 넣으면 멈추는 현상이 있어, 렌더러 UI 를 만든 뒤 UI 로 검증하는 게 낫다.
- 보기 A/B, SVG 가상화, 문장 호버, pagemerge 연동, 타이포 분리 전부 미착수.
- 도구 호출 상한(400)에 걸려 여기서 중단. 다음 세션은 PLAN-AI §9-P2 의 "다음 세션 착수점" 부터.

[2026-08-26 17:15] PLAN-AI P1 완료 — agy 사이드카. 「상주 세션」을 「웜 스페어 풀」로 뒤집었다

한 일:
- agy stream-json 프로토콜을 직접 실측하고 P1 을 구현했다. 신규 `ai/agy.ts`(탐지·로그인·
  에이전트·한도·GC) · `ai/agyPool.ts`(웜 스페어 풀) · `ai/agyBackend.ts`(AIBackend 구현).
  `service.ts` 의 `resolveBackend()` 한 곳만 바뀌었다 — P0 에서 세운 어댑터 경계가 값을 했다.
- 백엔드 선택 `auto | agy | rest`. auto 는 agy 가 살아 있으면 agy, 아니면 BYOK REST.
- 온보딩: 앱 안에서는 로그인이 불가능하므로(인가 코드를 stdin 으로 못 넣는다) 터미널을 열어 주고
  "다시 확인" 을 누르게 한다. 상태·한도·웜 스페어·차단기를 설정 화면 한 곳에 모았다.
- 문서를 열면 `agyPrewarm()` — 첫 번역 TTFT 6초 → 1.4초.

결정과 이유:
- **PLAN-AI 의 D1「지속 사이드카(상주 stream-json 세션)」를 폐기하고 웜 스페어 풀로 바꿨다.**
  같은 세션에서 3턴을 돌리니 입력 토큰이 3,885 → 3,985 → 4,090 으로 늘었다. 증가분이 정확히
  직전 턴의 user+assistant 다 — agy 는 **턴마다 대화 이력을 통째로 재전송**한다.
  짧은 문장이라 100토큰씩이지만 전문 번역 배치(턴당 3k in/3.5k out)면 총 입력이 단순합의
  약 5배가 된다. §2.5 의 "논문 1편 1.84%" 는 이 효과를 안 셌다.
  agy 엔 대화를 비우는 이벤트도 플래그도 없다(`--help` 전수 확인).
  → 프로세스를 미리 `init` 까지 데워 두고(5.9~6.2초, 임계 경로 밖) **한 프로세스당 1턴만 쓰고 폐기**.
  TTFT 1.6초는 그대로 유지하면서 이력 오버헤드가 0 이 된다. 실측 in≈3,956 이 턴을 거듭해도 평평했다.
- 메모리가 프로세스당 165MB 라 기본 풀은 웜 스페어 1개. 유휴 5분이면 정리한다.
- **대화 db GC 를 나이 기준으로 짜면 안 됐다.** 처음엔 `keepDays=7` 로 훑어 지우게 썼는데,
  이 기계의 `conversations/` 865개·1.0GB 중 대부분이 **사용자 본인의 agy 사용 기록**이다.
  갈피가 만든 `conversation_id` 만 파일에 적어 두고 그것만 지우는 방식으로 다시 썼다.
- 명시적으로 agy 를 고른 상태에서 agy 가 죽으면 **조용히 REST 로 갈아타지 않는다.**
  "구독으로 돌고 있다" 고 믿는 채로 유료 키가 태워지면 안 된다. auto 일 때만 폴백한다.
- 견적 EWMA 보정계수를 **백엔드별로 분리**했다. agy 는 턴당 에이전트 프롬프트 ~3,900 토큰이
  고정으로 붙어서, 하나로 두면 보정계수가 30배로 튀어 REST 쪽 견적까지 망가진다.

인사이트:
- 이벤트 봉투가 `{"event":"<이름>","<이름>":{…}}` 다. `type` 이 아니다. `conversation_id` 는
  **최상위**에 오고 나머지는 같은 이름의 키 안에 중첩된다.
- **`init.tools` 는 galpi 에이전트인데도 57개를 그대로 나열한다.** 에이전트 제한이 안 걸린 게
  아니라 그 필드가 CLI 레지스트리일 뿐이다. 실제 입력이 3,885(기본 에이전트 ~13,900)라
  D4 는 정상 작동 중이다. 이 필드를 헬스체크에 쓰면 안 된다.
- 취소 버그를 실측이 잡았다. `acquire()` 가 스페어 없을 때 6초 걸리는데 그 사이 취소가 오면
  **이미 abort 된 signal 에 `addEventListener` 를 걸어 영영 안 불렸다.** 결과적으로 취소를
  눌러도 턴이 끝까지 돌았다. acquire 직후 재확인 + 리스너 등록 직후 재확인으로 고쳤다.
  아직 한 턴도 안 쓴 세션은 이력이 없으니 죽이지 않고 스페어로 되돌린다.
- SQLite 는 `.db` 옆에 `-wal`/`-shm` 을 남긴다. 본체만 지우니 고아가 쌓였다 — 검증 중에 눈으로 확인.
- `agy -p "/usage"` 가 로그인 확인과 한도 조회를 겸한다. 무과금이라 둘을 하나로 합쳤다.

막힌 점 / 다음:
- 한도 초과 시 실제 이벤트 형태는 여전히 미확인(5시간 96.8%, 주간 99.8% 남아 강제 불가).
  `classifyAgyError` 가 `RESOURCE_EXHAUSTED|quota|429` 문자열로 잡게 해 뒀다 — 실제로 걸리면 재확인.
- 미로그인 온보딩 카드는 코드 경로만 있고 실물 확인은 못 했다(로그인된 상태라 강제 불가).
- agy 의 `thinking_tokens` 가 `output_tokens` 에 포함되는지 미확인(실측에서 둘 다 0 인 턴이 많았다).
  배타로 가정하고 있다 — thinking 이 붙은 턴(out=149/think=128)의 회계는 P3 에서 `/usage` 실측
  변화와 대조해 확정할 것.
- 다음은 P2(번역 본체). H5(rasterize dpi 고정)부터.

[2026-08-26 16:50] PLAN-AI P0 완료 — AI 위생·계측 계층 (백엔드 무관), H1~H8 중 6건 해소

한 일:
- `electron/` 을 모듈로 쪼갰다. main.ts 813줄 → 579줄, 신규 11파일 1,244줄.
  `paths.ts`(경로) · `settings.ts`(원자적 쓰기·부분 병합·secrets) · `usage.ts`(원장)
  · `ai/{types,restBackend,service,breaker,queue,estimate,pricing,prompts}.ts`.
- H1 API 키 평문 저장 제거. `secrets.json`(safeStorage 암호화, 0600)으로 분리하고
  최초 실행 시 `settings.json` 의 평문 키를 자동 이전. **키는 렌더러로 아예 안 간다** —
  UI 는 "저장됨" 여부(keyPresent)만 알고, 모델 목록 조회도 main 이 키를 읽는다.
- H2 `settings.json` tmp→rename + 최상위 얕은 병합(ai 만 한 단계 더). 렌더러가 6개 키만
  보내도 main 이 쓴 `pythonPath` 가 살아남는 걸 실측 확인.
- H3 429 재시도 제거 → 차단기 2층. provider 층(429 → retry-after 만큼 폐쇄, 계정 단위
  한도라 제공자 전체), feature 층(연속 3회 → 세션 종료). 재시도는 5xx/네트워크만 600→1800ms.
- H4 `migrateLegacyDataDir` 제거. `resolvePython` 의 PaperReader 폴백도 같이 죽은 코드라 삭제.
- H6 `AbortController` + `ai:cancel(jobId)`. 대기 중이면 큐에서 빼 실행조차 안 하고,
  실행 중이면 fetch 를 끊는다.
- H7 usage 수집. Gemini `usageMetadata` / OpenAI `stream_options:{include_usage:true}` /
  Anthropic `message_start`+`message_delta`.
- H8 죽은 `translate:text` 제거. `translate:stream` 도 `ai:stream` 으로 대체.
- 사용량 원장 §4.1 구현 — NDJSON append-only + 인메모리 집계(doc/day/job/feature) +
  `usage:changed` 200ms 디바운스 + 문서별 파생 캐시. 본문·프롬프트는 글자수만 남긴다.
- 검증: electron 스텁으로 실제 앱 코드를 헤드리스로 돌리는 하니스 4개 + 마지막엔 실제 앱을
  `--remote-debugging-port` 로 띄워 CDP 로 렌더러에서 직접 호출.

결정과 이유:
- **usage 정규화 규칙을 세웠다: `in` 은 캐시 미적중 입력만, `out` 은 thinking 제외.**
  Gemini `promptTokenCount` 는 캐시를 포함하고 OpenAI `completion_tokens` 는 reasoning 을
  포함하는데 Anthropic `input_tokens` 는 캐시를 제외한다. 안 맞추면 비용이 이중계상된다.
- 견적 EWMA 보정계수를 **원장에서 복원**하게 했다(계획엔 없던 것). 프로세스 메모리에만
  두면 앱을 끌 때마다 견적이 bias=1 로 리셋돼 §2.4 의 "est_in vs usage.in 으로 보정" 이
  영영 수렴하지 않는다. 합성 원장 8행으로 1 → 0.837 수렴 확인(견적 143 → 120, 실제 115).
- 키를 저장할 때 차단기를 자동 해제한다. 키가 틀려 3연속 실패로 기능이 닫혔는데
  키를 고친 뒤에도 수동으로 풀어야 하면 사용자가 원인을 못 찾는다.
- 취소된 호출도 원장에 남긴다(부분 out_chars 포함). 그때까지 쓴 토큰은 실제로 소모됐다.

인사이트:
- **Gemini 는 잘못된 API 키에 401 이 아니라 400 INVALID_ARGUMENT 를 준다.** 실측으로 잡았다.
  상태코드만 보고 분류하면 "설정 오류" 로 빠져 사용자가 키를 의심하지 않는다.
  `restBackend.ts` 의 `httpError` 가 본문을 `/api.?key not valid|API_KEY_INVALID/i` 로
  매칭해 auth 로 승격한다.
- 오류 본문을 그대로 UI 에 넣으면 안 된다. Gemini 400 응답은 200자를 잘라도 JSON 여는
  괄호만 보인다. `briefError()` 로 `error.message` 한 줄만 뽑는다. 차단기 사유에도 같은 값이
  들어가므로 이걸 안 하면 차단 메시지가 통째로 깨진 JSON 이 된다.
- 검증 하니스가 제 몫을 했다. `electron` 을 스텁으로 갈아끼우고 esbuild alias 로 번들하면
  **앱 코드를 한 줄도 안 고치고** main 프로세스 로직을 그대로 돌릴 수 있다.
  `globalThis.fetch` 를 가로채 503 을 2번 주입해 재시도(3,209ms = 600+1800+791) 와
  429 무재시도(retry-after 42초 → 다음 호출이 차단기에 막힘)를 실제로 확인했다.
- 마지막 검증은 CDP 로 했다. `npx electron . --remote-debugging-port=9333` 로 띄우고
  `node --experimental-websocket` 로 `Runtime.evaluate` 를 쏘면 렌더러에서
  `window.paperAPI.aiStream(...)` 을 직접 호출할 수 있다. preload↔IPC 계약까지 실측된다.
- 결함이 하나 더 나왔다: 실제 `settings.json` 에 Gemini 키가 평문으로 있었다(형식이
  `AIza…` 가 아니라 `AQ.Ab8…` 라 첫 유출 검사 정규식이 못 잡았다). 마이그레이션으로 해소.

막힌 점 / 다음:
- 취소 시 usage 는 0 으로 남는다 — 제공자가 usageMetadata 를 스트림 끝에만 주는데 그 전에
  끊기 때문이다. out_chars 로 대신 근사한다. P3 견적 보정에서 감안할 것.
- safeStorage 는 macOS 키체인을 쓴다. ad-hoc 서명 앱은 재빌드마다 서명이 바뀌므로
  **친구 배포본에서 키체인 접근 프롬프트가 뜰 가능성**이 있다. 이 기계에선 안 떴다.
  프롬프트가 뜨면 `enc:false` 폴백(0600 평문)으로 떨어진다 — P1 온보딩에서 확인 필요.
- 다음은 P1(agy 사이드카). `ai/service.ts` 의 `resolveBackend()` 한 줄이 교체 지점이다.
  P2 의 H5(rasterize dpi 고정)는 아직 그대로다.

[2026-08-26 16:23] AI 내장 계획 확정 — agy 구독 백엔드 조사·실측, 대조 UI 시안, PLAN-AI.md

한 일:
- 백엔드 후보 4개(1회성 서브프로세스 / agy 상주 사이드카 / 네이티브 직접호출 / BYOK 유지)를
  실측 비교해 **agy 지속 사이드카 + BYOK 폴백**으로 확정. 병렬 조사 9에이전트 + 직접 실측 12항목.
- agy 실측: 증분 스트리밍 있음(200ms 델타), 웜 턴 0.8~1.7초, 미니멀 에이전트로 오버헤드
  13,990→4,010 토큰(-71%), 5개 병렬 OK, `agy -p "/usage"` 가 **무과금**으로 잔량 제공.
- 한도 소모 모델을 2점 회귀로 도출: 입력 3.306e-8/토큰, 출력 3.795e-7/토큰(입력의 11.5배).
  5시간 버킷 = 입력환산 30.2M, 주간 = 5시간의 6배.
- 번역 품질 검증: 실제 논문 4개 쪽을 번역시켜 LaTeX 무손실 확인. `-low` 와 `-medium` 차이가
  용어 표기 수준이라 기본을 low 로 확정(비용 3.5배 차이).
- 문장 정렬 번역 프롬프트 확립 — "en 조각을 이어붙이면 원문이 되어야 한다" 제약으로
  38개 블록 전부 왕복 검증 통과, 앵커 되짚기 99.5% 커버리지.
- PDF 벡터 추출 검증: `page.get_svg_image(text_as_path=True)` → gzip 25KB/쪽(PNG 242KB),
  `fill` 미지정이라 CSS 한 줄로 테마 적용. 스캔본(MacKinlay)만 예외로 래스터 유지.
- 대조 레이아웃 시안 3종 제작 후 A(리플로우‖번역, 블록 정렬) 기본 + B(원본‖번역) `⌥O` 토글로
  확정, C(인터리브) 폐기. 캔버스 팬/핀치줌, 연속 스크롤, 카드 폭 드래그, 문장 호버 연결 포함.
- `~/Library/Application Support/PaperReader/` 삭제(118MB, 테스트 문서 5편).
- `PLAN-AI.md` 신설 — 다음 세션이 그것만 읽고 착수할 수 있는 인수인계 문서.
  결정 16건, 실측 데이터, 스키마, 검증된 프롬프트 원문, P0~P5 단계별 통과 조건, 참고 좌표.

결정과 이유:
- 네이티브 직접호출을 버린 결정적 근거는 속도가 아니라 **버킷**이다. agy `/usage` 가 노출하는
  한도가 `gemini-weekly`/`gemini-5h`/`3p-weekly` 로 Antigravity 전용이고, 사용자 본인의
  `gemini-sub` 주석도 "Antigravity 사용량은 일반 Gemini 와 공유되지 않는다" 고 적어놨다.
  구독으로 쓰겠다는 전제가 무너진다. 덤으로 남의 client_id 사칭 문제도 피한다.
- 미니멀 에이전트의 주목적은 토큰이 아니라 **보안**. 기본 에이전트는 run_command·write_to_file
  포함 툴 57개인데 우리가 먹이는 건 남이 쓴 PDF 본문이다. 한도 절감은 15%뿐이다.
- 줌을 `transform: scale()` 로 하면 안 된다. `will-change: transform` 이 GPU 레이어로 승격시키고
  그 레이어는 승격 시점 해상도로 한 번만 래스터화된다 → 벡터도 한글도 전부 뭉개진다.
  제스처 중만 transform, 140ms 뒤 `zoom`(레이아웃)으로 확정하는 2단 방식으로 해결.
- 번역 타이포는 패널을 합치되 값은 분리. 영문 세리프 16.5px 과 한글 15.5px 은 같은 크기가
  아니라는 게 실사용에서 드러났다(편한 값이 11px). 글꼴만 연동 기본.

인사이트:
- 견적을 두 번 정정했다. ① "배치가 17배 레버" 는 토큰 **개수** 기준이었고 비용 기준으론 2.9배.
  ② 초안의 논문 1편 1.3% 는 낙관이었고 실제는 1.8~2.3%. 범인은 thinking 토큰(출력으로 과금).
- 조사 보고서가 "확인" 이라 라벨링한 것 중 근거가 추론인 게 여럿 있었다. 완결성 비평가를
  따로 붙인 게 값을 했다 — 6개 보고서가 백엔드를 확정 못 했고 두 결론이 배타적인데 서로를
  반박하지 않는다는 걸 잡아냈다.
- 코드 결함 5개가 조사 부산물로 나왔다: API 키 평문 저장, settings.json 통짜 덮어쓰기
  (렌더러가 6개 키만 보내 main 이 쓴 pythonPath 가 소멸), 429 재시도(차단기여야 함),
  usage 수집 누락, rasterize dpi=200 고정(스캔본 원본 4300x6000 을 1434x2000 으로 축소).
- `migrateLegacyDataDir` 이 안 돌던 이유는 `existsSync(cur)` 가 참이라 즉시 반환한 것.
  두 폴더가 나란히 살아 있었다. PaperReader 삭제로 죽은 코드가 됐다.

막힌 점 / 다음:
- 이번 세션은 계획까지만. 구현 없음. 다음 세션은 `PLAN-AI.md` P0 부터.
- 도구 호출 상한으로 시안의 실제 브라우저 렌더 검증은 못 했다(정적 검증만 통과).
- 미확정: 한도 초과 시 이벤트 형태(한도가 99% 남아 강제 불가), 5분+ 유휴 생존,
  figure bbox 오려내기, 축 2(패널 배치)·축 3(미터 배치) 시안.
- 조사 중 `~/.gemini/config/agents/{gmini,galpi}/agent.md` 생성. gmini 는 테스트용이라 삭제 가능.

[2026-07-04 21:50] 형광펜 버그 수정(오프바이원·⇧H·패널 가림) + 0.1.13 릴리스

한 일:
- 형광펜 오프바이원 수정(highlights.ts occurrenceOf): compareBoundaryPoints 의 how 인자
  이름이 (source, this) 순서라 END_TO_START 는 "매치 시작 ↔ 선택 끝" 비교가 돼 선택
  자신까지 세어 다음 출현이 칠해졌음. START_TO_END("매치 끝 ↔ 선택 시작")로 교정.
  Electron Range 로 검증(2번째 foo 선택 → 기존 2, 수정 1).
- ⇧H(키워드 형광펜) 안 먹던 문제(HighlightLayer): 탭/홀드를 keyup 타이밍으로 갈랐는데
  수식 키를 누른 채로는 문자 키 keyup 이 유실돼(macOS/Chromium) 탭이 '제거'로 오판됨.
  → 탭은 keydown 에서 즉시 적용, 홀드 제거는 OS 키 반복(e.repeat)+HOLD_MS 로만 판정.
  keyup 의존 제거. (H 단독→키워드 오작동은 Shift 잔류로 인한 것 — 코드 버그 아님.)
- 주석 패널 복사 버튼 가림 수정(App.tsx): 패널이 reader-root 기준 top:0(z:40)라 sticky
  상단바(z:45)가 머리줄(복사·닫기)을 덮었음. 패널을 reader-body 안으로 이동 → 상단바
  아래부터 시작.

막힌 점 / 다음:
- 홀드 제거 시 탭(색 순환)이 먼저 적용됐다가 반복 신호로 제거되어 짧은 색 깜빡임 있음
  (기능상 정상). 거슬리면 keydown-탭을 지연 적용하는 방안 검토 가능.

[2026-07-04 20:56] 고아 "extracting" 상태 복구 + 0.1.12 릴리스

한 일:
- 추출 도중 앱 종료로 status.json 이 "extracting" 에 고착되는 문제 복구(직전 로그의
  '다음 개선 후보'): main.ts sweepStaleExtracting() — 앱 시작 시(startDocsWatcher 직전)
  docs 폴더를 훑어 추출 큐에 없는 "extracting" 문서를 "error" 로 전환(pages_done 등
  기존 필드 보존). 라이브러리 카드 doc-foot 에 error 표시 "추출 실패 — 우클릭 → 다시
  추출"(styles.css .foot-error, danger 색) → 기존 재추출로 복구 가능.
- 0.1.12 릴리스: 커밋 안 됐던 기능 일괄 포함(제목/저자 추출 개선·주석 MD 내보내기·
  수식 편집·⌘P·⌘O·재추출·섹션 표시·읽던 위치 복원·드래그드롭 플리커/주석 유실/메모
  호버 수정·uninstall-mac.sh·BACKEND_HANDOFF.md).

결정과 이유:
- 스윕은 앱 시작 시 1회만: 추출 큐는 메모리 상주라 시작 시점엔 항상 비어 있음 —
  그때 "extracting" 인 문서는 전부 고아가 확실. 만일을 위한 extractActive/큐 가드 포함.

막힌 점 / 다음:
- document.json 생성 전(첫 페이지 전) 죽은 문서는 error 로 바꿔도 라이브러리에 안 뜸
  (docs:list 가 document.json 없는 폴더 스킵) → PDF 재드롭만 가능. 필요 시 후속.

[2026-07-04 19:50] 제목/저자 추출 개선 + 기능 5종(주석 MD·수식 편집·⌘P·재추출·섹션 표시)

한 일:
- 제목/저자 추출 개선(paper_meta.py): PDF 메타데이터 쓰레기 값 거부(_usable_title —
  워드프로세서명·.doc 파일명·PII/DOI·URL) + 1페이지 최대 글꼴 폴백(_title_from_page1,
  단어 2개+·12자+·상단 60%·본문 크기 대비 1.15× 조건으로 저널 로고 오탐 차단) +
  저자 계정명 거부(_plausible_authors) + 저자 수집 창 3→5줄(FAMA and FRENCH 잘림 해결).
  오늘 받은 5편 전부 검증 통과. 기존 3편은 document.json 제자리 패치(와처가 라이브 갱신).
  MacKinlay 는 스캔본(텍스트 레이어 없음) → 기존 build_document 첫 heading 폴백이 처리.
- 주석 Markdown 내보내기(annotations/exportMd.ts + 패널 복사 버튼): 문서 순서 정렬
  (Range.compareBoundaryPoints), 메모=인용+본문·형광펜=색/키워드 표기 → 클립보드.
- 수식 LaTeX 인라인 수정(§11-10): SourcePeek 수식 블록이면 하단 편집 스트립
  (textarea+KaTeX 라이브 프리뷰+저장/원래대로). state.json formula_edits 사이드카
  (useAnnotations 확장) → 재추출에도 보존. App 렌더에서 latex 오버라이드.
- ⌘P 퀵 스위처(nav/QuickSwitcher.tsx): 최근 읽은 순+타이핑 필터+↑↓/Enter.
  library.json 이름변경 오버라이드 반영. 키맵 quickSwitch 등록.
- 재추출: extract.py --doc-id(같은 폴더 갱신, source.pdf 자기복사 가드) +
  main.ts pipeline:reextract(직렬 큐 공용) + 라이브러리 우클릭 "다시 추출".
  주석·읽기상태는 state.json 이라 그대로 보존됨.
- 현재 섹션 스티키 표시: SectionRail active 재사용, 본문 좌상단 muted 라벨(표시 전용).
- 제거/업데이트 조사: 앱 삭제 시 ~5GB 잔존(pyenv 1.7G + HF 모델 3.2G + 데이터).
  pipeline/uninstall-mac.sh 신규(문서 삭제는 별도 확인) + DISTRIBUTE.md §D.
  업데이트 확인 검증: repo 공개·latest v0.1.11·dmg 에셋·다운로드 URL 모두 정상.
- SourcePeek CropPopover 에 key={block.id} — 블록 연속 클릭 시 뷰/초안 스테일 수정.

결정과 이유:
- 제목 폴백을 MinerU heading 이 아니라 fitz 1페이지 파싱으로 한 이유: 메타는 추출
  시작 즉시 필요(스트리밍 초기 기록). MinerU heading 폴백은 build_document 에 이미 있어
  이중 안전망이 됨(스캔본 커버).
- 재추출에 --doc-id 오버라이드가 필수인 이유: source.pdf 로 추출하면 파일명 stem 이
  "source"라 doc_id 가 달라져 새 문서가 생겨버림.
- 주의: 설치본(0.1.11) 번들 파이프라인은 구버전 — 이번 수정 전부 다음 릴리스에 실려야
  앱 드롭 추출에 반영됨. (오늘 패치·백그라운드 추출은 dev 파이프라인으로 이미 적용)

막힌 점 / 다음:
- Fama 1992 는 dev 파이프라인으로 백그라운드 추출 중(메타 정상 확인, 완료는 수 분).
- MacKinlay 첫 추출이 앱 종료로 chunk 도중 죽어 "extracting" 에 고착됐었음 —
  다음 개선 후보: 앱 시작 시 고아 "extracting" 상태 감지 → error 로 전환(재추출 유도).

[2026-07-04 19:04] 드래그-드롭 플리커 수정 + 주석 유실 수정 + 읽던 위치 복원/⌘O

한 일:
- PDF 드래그 오버레이 플리커 수정(App.tsx): 요소별 React onDragOver/onDragLeave + 오버레이
  마운트 방식이 원인 — 오버레이가 뜨는 순간 원래 요소에 dragleave 가 튀어
  숨김↔표시 무한 반복, 그 틈에 drop 도 씹힘. window 레벨 dragenter/dragleave
  깊이 카운터로 교체, 오버레이는 pointer-events:none. dropProps 프롭 제거(Library 포함).
- 주석 유실 버그 수정(useAnnotations.ts): 형광펜/메모 생성 후 300ms 디바운스 안에
  문서를 나가면 loadedFor/refs 가 먼저 리셋돼 예약된 저장이 스킵 → flushPersist()
  추가(문서 전환 effect 첫 줄 + 언마운트에서 즉시 커밋).
- 메모 호버 영구 먹통 수정(NotesLayer.tsx): effect cleanup 이 RAF 취소 후
  hoverRaf.current 를 null 로 안 돌려 다음 effect 의 스로틀이 영구 차단되던 것.
- 읽던 위치 기억/복원 신규(nav/useScrollMemory.ts): 화면 최상단 블록 id + 블록 내
  진행률을 state.json scroll_anchor 로 저장(600ms 디바운스, 나갈 때 flush), 문서
  다시 열면 그 문장 근처로 복원. 절대 px 이 아니라 타이포 변경(reflow)에도 견딤.
  state.json 은 docs 와처(document.json|status.json 필터) 밖이라 재로드 유발 없음.
- ⌘O PDF 열기 신규: main.ts pdf:pick(showOpenDialog, multiSelections) + preload
  pickPdfs + 키맵 openPdf 등록(기본 Mod+O, 단축키 패널에 자동 노출·재바인딩 가능).
  추출 루프는 extractPaths() 로 공용화(드롭·⌘O 동일 경로).

결정과 이유:
- 드롭 감지를 window 레벨로 올린 이유: 오버레이 마운트가 이벤트 대상을 바꾸는 한
  요소 단위 감지는 구조적으로 플리커 → 전역 카운터 + 무간섭 오버레이가 유일한 안정 해법.
  내부 카드 드래그는 types 의 application/x-galpi-move 로 계속 구분.
- 스크롤 앵커를 블록 기반으로 한 이유: scrollTop/ratio 는 글자크기·폰트 변경 시 어긋남.
  data-block-id 가 전 블록에 이미 붙어 있어 공짜로 정밀 복원 가능.
- 탐색 에이전트가 지목한 FootnoteRef 리스너 누수·translateStream 레이스는 코드 확인
  결과 오탐(둘 다 cleanup/id 필터 있음) — 수정 안 함.

막힌 점 / 다음:
- 이미지(figure) 로드로 앵커 위 레이아웃이 늦게 변하면 복원 위치가 약간 밀릴 수 있음
  (블록 앵커라 크게 어긋나진 않음). 문제 되면 이미지 로드 후 1회 재보정 고려.

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
