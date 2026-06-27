# 배포 가이드 (macOS, 친구에게 공유 + 업데이트)

이 앱은 **무료·미서명** 방식으로 배포한다. 자동(백그라운드) 업데이트는 Apple Developer
서명($99/년)이 필요하므로 사용하지 않고, 대신 **수동 업데이트**(앱 안에서 "업데이트 확인" →
다운로드 페이지 열기)를 쓴다.

또 하나 중요한 점: **PDF 추출 엔진(MinerU, ~5GB)은 .dmg 에 들어가지 않는다.** 앱에는 추출
스크립트(`extract.py` 등)만 동봉되고, 무거운 Python venv + 모델은 친구가 셋업 스크립트로 한 번
설치한다. (번역은 Gemini 클라우드라 키만 넣으면 됨.)

전제: 친구도 **Apple Silicon Mac**. (현재 빌드는 arm64 전용)

---

## A. 내가 할 일 — 빌드 & 릴리스

### 1) 릴리스를 공개로 받게 하기 (한 번만)
친구가 다운로드/업데이트 확인을 하려면 릴리스가 **public** 이어야 한다. 둘 중 하나:
- 이 저장소(`ChanchanCode/galpi`)를 public 으로 전환, 또는
- 릴리스 전용 public 저장소를 따로 만들고 `app/package.json` 의 `build.publish.repo` 와
  `app/electron/main.ts` 의 `RELEASES_REPO` 를 그 저장소로 바꾼다.

### 2) 버전 올리기
`app/package.json` 의 `"version"` 을 올린다 (예: `0.1.0` → `0.2.0`). 업데이트 확인은 이 값과
최신 릴리스 태그를 비교한다.

### 3-a) CI 로 자동 빌드 (권장)
태그를 푸시하면 GitHub Actions(`.github/workflows/release.yml`)가 macOS 러너에서 빌드해
릴리스에 `.dmg` 를 올린다.
```bash
git tag v0.2.0
git push origin v0.2.0
```

### 3-b) 로컬에서 직접 빌드
```bash
cd app
npm run build
npx electron-builder --mac            # release/갈피-<버전>-arm64.dmg 생성
# 또는 릴리스에 바로 업로드:
GH_TOKEN=<github_personal_access_token> npx electron-builder --mac --publish always
```
산출물: `app/release/갈피-<버전>-arm64.dmg`

### 4) 친구에게 전달
릴리스 페이지 링크를 주거나 `.dmg` 파일을 직접 보낸다(AirDrop/드라이브 등).

---

## B. 친구가 할 일 — 설치 (한 번)

### 1) 앱 설치 + Gatekeeper 우회 (미서명이라 최초 1회)
1. `.dmg` 를 열고 **갈피** 를 `응용 프로그램`으로 드래그.
2. 처음 실행 시 "확인되지 않은 개발자" 경고가 뜨면:
   - **응용 프로그램에서 갈피 를 우클릭 → 열기 → 열기**, 또는
   - **시스템 설정 → 개인정보 보호 및 보안 → "확인 없이 열기"**.

### 2) 추출 엔진 설치 (자기 PDF 를 변환하려면 필요)
터미널에서 아래 한 줄 실행 (앱에 동봉된 스크립트):
```bash
bash "/Applications/갈피.app/Contents/Resources/pipeline/setup-mac.sh"
```
- Python 3.12(없으면 Homebrew 로 설치) + MinerU/PyMuPDF 를 기본 위치
  `~/Library/Application Support/PaperReader/pyenv` 에 설치한다.
- 5GB+ 다운로드라 시간이 걸린다. 첫 추출 때 모델을 추가로 받는다.
- 설치 후 앱을 다시 열고 PDF 를 창에 끌어다 놓으면 추출이 시작된다.
- 앱이 엔진을 못 찾으면 **설정(⚙) → 추출 엔진 → "Python 직접 지정"** 에서
  `~/Library/Application Support/PaperReader/pyenv/bin/python` 을 고른다.

### 3) 번역 쓰려면 (선택)
**설정 → 번역**에 Gemini API 키 입력 (aistudio.google.com 무료 발급).

---

## C. 업데이트 (수동)
- 친구: 앱 **설정(⚙) → 버전 → "업데이트 확인"**. 새 버전이 있으면 "다운로드 페이지 열기" 로
  최신 `.dmg` 를 받아 다시 설치한다. (설정/문서/추출 엔진은 그대로 유지됨)
- 추출 엔진은 보통 그대로 재사용된다. requirements 가 바뀐 큰 업데이트면 셋업 스크립트를 다시 실행.

## 참고 — 진짜 자동 업데이트가 필요해지면
Apple Developer Program($99/년) 가입 → 서명 + 공증 → `electron-updater` 도입 시,
앱이 백그라운드로 새 릴리스를 받아 다음 실행 때 자동 적용된다. (지금 구조에서 추가 가능)
