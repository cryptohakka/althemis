#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE="logs/oracle.pid"
mkdir -p logs

# 既存oracleを一掃（pidfile + 取りこぼし両方）
if [ -f "$PIDFILE" ]; then
  OLD=$(cat "$PIDFILE")
  kill "$OLD" 2>/dev/null || true
fi
pkill -f "protocol/oracle.ts" 2>/dev/null || true
sleep 2

# ログ退避
[ -f logs/oracle.log ] && mv logs/oracle.log "logs/oracle.log.bak.$(date +%s)"

# node直import起動（tsx shim連鎖なし＝1プロセス）
setsid node --import tsx/esm protocol/oracle.ts > logs/oracle.log 2>&1 &
echo $! > "$PIDFILE"
sleep 8

echo "--- pid ---"; cat "$PIDFILE"
echo "--- proc ---"; ps aux | grep "oracle.ts" | grep -v grep
echo "--- log ---"; tail -n 12 logs/oracle.log
