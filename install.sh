#!/usr/bin/env bash
# Trình cài đặt nhanh 1 lệnh cho agent-updater trên máy mới hoặc WSL mới.
# Cách dùng:
#   bash install.sh --target /duong/dan/du-an [--zsh]

set -euo pipefail

APP_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO=""
SETUP_ZSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET_REPO="${2:-}"
      shift 2
      ;;
    --target=*)
      TARGET_REPO="${1#*=}"
      shift
      ;;
    --zsh)
      SETUP_ZSH=1
      shift
      ;;
    *)
      echo "Tham số không hỗ trợ: $1" >&2
      echo "Cách dùng: bash install.sh --target /duong/dan/du-an [--zsh]" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Chưa cài đặt Node.js (>= 20). Vui lòng cài Node.js trước." >&2
  exit 1
fi

chmod +x "$APP_DIR/bin/agent-updater" "$APP_DIR/src/cli.mjs"

if [[ -z "$TARGET_REPO" && -f "$PWD/.agent/scripts/validate-agent-system.mjs" ]]; then
  TARGET_REPO="$PWD"
fi

if [[ -n "$TARGET_REPO" ]]; then
  node "$APP_DIR/src/cli.mjs" init --target="$TARGET_REPO"
elif [[ -f "$APP_DIR/config.local.json" ]]; then
  node "$APP_DIR/src/cli.mjs" install-service
else
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$APP_DIR/bin/agent-updater" "$HOME/.local/bin/agent-updater"
  echo "✔ Đã gắn lệnh '$HOME/.local/bin/agent-updater'."
  echo "👉 Tiếp theo hãy trỏ vào dự án cần tự nâng cấp bằng lệnh:"
  echo "   agent-updater init --target /duong/dan/du-an"
fi

if (( SETUP_ZSH )) && [[ -f "$HOME/.zshrc" ]]; then
  if ! grep -q "agent_updater_status.json" "$HOME/.zshrc"; then
    cat >> "$HOME/.zshrc" <<'EOF'

# Nhắc gọn 1 dòng nếu có gói nâng cấp Agent nhạy cảm đang chờ duyệt
if [[ -o interactive && -f "$HOME/.agent_updater_status.json" ]]; then
  __ag_pending=$(grep -o '"pending_count":[[:space:]]*[0-9]*' "$HOME/.agent_updater_status.json" 2>/dev/null | grep -o '[0-9]*' || echo 0)
  if [[ -n "$__ag_pending" && "$__ag_pending" -gt 0 ]]; then
    printf '\033[1;33m⚡ [agent-updater] Có %s gói nâng cấp luật gốc đang chờ duyệt -> gõ: agent-updater review\033[0m\n' "$__ag_pending"
  fi
  unset __ag_pending
fi
EOF
    echo "✔ Đã gắn dòng nhắc chờ duyệt vào ~/.zshrc."
  fi
fi
