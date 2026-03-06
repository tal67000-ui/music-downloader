#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT_DIR/tmp/runtime"
APP_PID_FILE="$PID_DIR/app.pid"

if [[ ! -f "$APP_PID_FILE" ]]; then
  echo "App is not running."
  exit 0
fi

APP_PID="$(cat "$APP_PID_FILE")"

if ps -p "$APP_PID" >/dev/null 2>&1; then
  kill "$APP_PID"
  echo "Stopped app PID $APP_PID"
else
  echo "PID $APP_PID was not running."
fi

rm -f "$APP_PID_FILE"
