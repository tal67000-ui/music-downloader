#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT_DIR/tmp/runtime"
APP_PID_FILE="$PID_DIR/app.pid"

mkdir -p "$PID_DIR"

cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env first."
  exit 1
fi

if [[ -f "$APP_PID_FILE" ]]; then
  APP_PID="$(cat "$APP_PID_FILE")"
  if ps -p "$APP_PID" >/dev/null 2>&1; then
    echo "App already running with PID $APP_PID"
    exit 0
  fi
  rm -f "$APP_PID_FILE"
fi

npm run build >/dev/null
nohup npm run start >"$PID_DIR/app.log" 2>&1 &
echo $! >"$APP_PID_FILE"
echo "App started on http://127.0.0.1:8786 with PID $(cat "$APP_PID_FILE")"
