#!/usr/bin/env bash
#
# demo.sh — 一键启动 FengAgent Demo
#
# 启动 WebUI 服务模式，自动打开浏览器。
# 用法：bash scripts/demo.sh
#
# 环境变量：
#   FENG_MODEL              模型 ID（默认 claude-sonnet-4-20250514）
#   FENG_PROVIDER           LLM 提供商（anthropic / openai / openai-compatible / bedrock / google）
#   ANTHROPIC_API_KEY       Anthropic API Key（使用 Anthropic 时必填）
#   OPENAI_API_KEY          OpenAI API Key（使用 OpenAI 时必填）
#   FENG_SERVER_PORT        服务端口（默认 3000）
#   FENG_SERVER_HOST        服务监听地址（默认 127.0.0.1）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# 检查 API Key
check_api_key() {
  local provider="${FENG_PROVIDER:-anthropic}"
  case "$provider" in
    anthropic)
      if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
        echo "❌ ANTHROPIC_API_KEY is not set."
        echo "   export ANTHROPIC_API_KEY=sk-ant-..."
        exit 1
      fi
      ;;
    openai)
      if [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "❌ OPENAI_API_KEY is not set."
        echo "   export OPENAI_API_KEY=sk-..."
        exit 1
      fi
      ;;
    openai-compatible)
      if [ -z "${OPENAI_COMPATIBLE_API_KEY:-}" ]; then
        echo "❌ OPENAI_COMPATIBLE_API_KEY is not set."
        echo "   export OPENAI_COMPATIBLE_API_KEY=..."
        echo "   export OPENAI_COMPATIBLE_BASE_URL=..."
        exit 1
      fi
      ;;
  esac
}

# 检查 web-ui 是否已构建，未构建则自动构建
ensure_web_ui_built() {
  local web_ui_dist="$PROJECT_ROOT/packages/web-ui/dist"
  if [ ! -d "$web_ui_dist" ] || [ -z "$(ls -A "$web_ui_dist" 2>/dev/null)" ]; then
    echo "📦 Building web-ui (first time only)..."
    (cd "$PROJECT_ROOT/packages/web-ui" && bun install && bun run build)
    echo "✅ web-ui built."
  fi
}

# 开启浏览器
open_browser() {
  local port="${FENG_SERVER_PORT:-3000}"
  local host="${FENG_SERVER_HOST:-127.0.0.1}"
  local url="http://${host}:${port}"

  echo "🌐 Opening browser at $url"

  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" &>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$url" &>/dev/null || true
  elif command -v start &>/dev/null; then
    start "$url" &>/dev/null || true
  else
    echo "   Could not auto-open browser. Please visit: $url"
  fi
}

main() {
  echo "🚀 Starting FengAgent Demo..."

  check_api_key
  ensure_web_ui_built

  # 后台打开浏览器（延迟 2 秒等待服务启动）
  (sleep 2 && open_browser) &

  # 启动服务
  echo "   Press Ctrl+C to stop."
  echo ""
  bun run packages/server/src/entry.ts
}

main
