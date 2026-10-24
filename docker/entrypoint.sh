#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Control commands need neither the desktop nor another browser instance.
if [[ "${1:-run}" == "resume" || "${1:-run}" == "status" ]]; then
  exec node /app/src/index.mjs "$@"
fi

pids=()
cleanup() {
  trap - TERM INT EXIT
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

Xvfb "$DISPLAY" -screen 0 1280x900x24 -nolisten tcp &
pids+=("$!")
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 50 ]]; then echo 'Xvfb did not become ready' >&2; exit 1; fi
  sleep 0.1
done
openbox >/dev/null 2>&1 &
pids+=("$!")
# Raw VNC stays inside the container. HTTP is published on host loopback only.
x11vnc -display "$DISPLAY" -localhost -nopw -forever -shared -rfbport 5900 -quiet &
pids+=("$!")
websockify --web=/usr/share/novnc 6080 localhost:5900 &
pids+=("$!")
node /app/src/index.mjs "$@" &
pids+=("$!")

set +e
wait -n "${pids[@]}"
result=$?
set -e
exit "$result"
