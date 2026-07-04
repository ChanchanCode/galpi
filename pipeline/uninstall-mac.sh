#!/bin/zsh
# 갈피 완전 삭제 스크립트 (macOS).
# 앱(.app)만 휴지통에 버리면 추출 엔진·모델·데이터 약 5GB 가 남는다 — 이 스크립트가 마저 지운다.
#   1) /Applications/Galpi.app                                   앱 본체
#   2) ~/Library/Application Support/Galpi/pyenv                 추출 엔진 (Python venv + MinerU, ~1.7GB)
#   3) ~/.cache/huggingface/hub/models--opendatalab--*           MinerU 모델 캐시 (~3.2GB, 갈피 전용)
#   4) ~/Library/Application Support/갈피                         Electron 캐시
#   5) ~/Library/Preferences/com.galpi.app.plist                 시스템 설정 찌꺼기
#   6) ~/Library/Application Support/Galpi (docs/settings)       문서·형광펜·메모 — 물어보고 삭제
set -e

echo "갈피를 완전히 삭제합니다."
read "ok?계속할까요? [y/N] "
[[ "$ok" == [yY]* ]] || exit 0

# 실행 중이면 종료
osascript -e 'quit app "Galpi"' 2>/dev/null || true
sleep 1

rm -rf "/Applications/Galpi.app" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Galpi/pyenv"
rm -rf "$HOME/.cache/huggingface/hub/"models--opendatalab--* 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/갈피"
rm -f "$HOME/Library/Preferences/com.galpi.app.plist"
echo "앱·추출 엔진·모델 캐시 삭제 완료."

data="$HOME/Library/Application Support/Galpi"
if [[ -d "$data" ]]; then
  size=$(du -sh "$data" 2>/dev/null | cut -f1)
  read "deldata?추출한 문서와 형광펜·메모($size)도 지울까요? 지우면 복구할 수 없습니다. [y/N] "
  if [[ "$deldata" == [yY]* ]]; then
    rm -rf "$data"
    echo "문서 데이터 삭제 완료."
  else
    echo "문서 데이터는 남겨두었습니다: $data"
  fi
fi
echo "완료."
