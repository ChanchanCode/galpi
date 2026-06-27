#!/usr/bin/env bash
# Paper Reader 추출 엔진 설치 (macOS · Apple Silicon)
# 이 스크립트는 PDF를 논문 뷰어용 데이터로 변환하는 MinerU 엔진을 설치합니다.
# 앱이 기본으로 찾는 위치(~/Library/Application Support/PaperReader/pyenv)에 venv를 만듭니다.
set -euo pipefail

APPSUP="$HOME/Library/Application Support/PaperReader"
VENV="$APPSUP/pyenv"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "──────────────────────────────────────────────"
echo " Paper Reader 추출 엔진(MinerU) 설치"
echo " 설치 위치: $VENV"
echo " ⚠️  의존성+모델로 5GB 이상 내려받습니다. 시간이 걸립니다."
echo "──────────────────────────────────────────────"

# 1) Python 3.12 확인 (없으면 Homebrew로 설치, Homebrew 없으면 자동 설치)
PY="$(command -v python3.12 || true)"
if [ -z "$PY" ]; then
  echo "→ python3.12 가 없습니다. Homebrew로 설치를 시도합니다."

  # 이미 설치돼 있지만 PATH 에 없을 수 있어 표준 경로 보강
  if ! command -v brew >/dev/null 2>&1; then
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  fi

  # 그래도 없으면 Homebrew 자동 설치
  if ! command -v brew >/dev/null 2>&1; then
    echo "→ Homebrew 가 없습니다. 자동 설치를 시작합니다."
    echo "  (관리자 비밀번호 입력 창이 한 번 뜰 수 있습니다. 설치에 시간이 걸려요.)"
    ME="$(whoami)"
    # /opt/homebrew 를 먼저 만들고 소유권을 현재 사용자에게 → 이후 설치는 sudo 없이 진행(프롬프트 멈춤 방지).
    # GUI 관리자 인증 1회(터미널 비번 입력이 불가한 앱 환경 대응).
    osascript -e "do shell script \"mkdir -p /opt/homebrew && chown -R ${ME}:admin /opt/homebrew\" with administrator privileges" \
      || { echo "✗ 관리자 권한 획득에 실패했습니다. https://brew.sh 안내대로 설치 후 다시 시도하세요."; exit 1; }
    # 비대화식 설치(NONINTERACTIVE) — 위에서 디렉터리를 미리 만들어 sudo 불필요.
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
      || { echo "✗ Homebrew 설치 실패. 인터넷 연결을 확인하거나 https://brew.sh 에서 수동 설치 후 다시 시도하세요."; exit 1; }
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo "→ Homebrew 설치 완료: $(brew --version | head -1)"
  fi

  brew install python@3.12
  PY="$(brew --prefix)/bin/python3.12"
fi
echo "→ Python: $PY  ($("$PY" --version 2>&1))"

# 2) venv 생성 + 의존성 설치
mkdir -p "$APPSUP"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip wheel
echo "→ MinerU / PyMuPDF 설치 중… (수 분 소요)"
"$VENV/bin/pip" install -r "$DIR/requirements.txt"

echo ""
echo "✅ 설치 완료."
echo "   venv: $VENV"
echo "   이제 Paper Reader 를 다시 열고 PDF를 끌어다 놓으세요."
echo "   (첫 추출 때 MinerU 가 모델을 추가로 내려받습니다.)"
echo ""
echo "   앱에서 엔진을 못 찾으면: 설정 → 추출 엔진 → 'Python 직접 지정' 에서"
echo "   다음 파일을 선택하세요:  $VENV/bin/python"
