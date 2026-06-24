#!/usr/bin/env bash
set -euo pipefail
cd ~/althemis
echo "=== 全 main.js 停止 ==="
pkill -f "main.js" 2>/dev/null || true
sleep 2
pgrep -af "main.js" && { echo "✗ まだ生きてる — 手動kill要"; exit 1; } || echo "  停止確認OK(0件)"
echo "=== main.js 起動(tsx経路・1本)==="
[ -f logs/main.log ] && mv logs/main.log "logs/main.log.bak.$(date +%s)"
nohup ./node_modules/.bin/tsx main.js > logs/main.log 2>&1 &
echo $! > logs/main.pid
sleep 10
echo "--- pid ---"; cat logs/main.pid
echo "--- proc ---"; pgrep -af "main.js"
echo "--- log ---"; tail -n 25 logs/main.log
