#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# A kernel lock is released even after SIGKILL/container loss. The metadata
# file remains only for diagnosis and compatibility with older installations.
# Never remove collection.guard: unlinking it would create a second lock inode.
unset COLLECTION_FLOCK_HELD
case "${1:-run}" in
  collection-run|collection-scan|collection-login|collection-resume|collection-unlock|relabel-once|relabel-resume)
    mkdir -p "${DATA_DIR:-/data}"
    exec 9>"${DATA_DIR:-/data}/collection.guard"
    if ! flock -n 9; then
      echo '{"event":"collection_locked","message":"Un autre parcours ou une commande de maintenance possède le verrou Linux. Aucun navigateur lancé."}'
      if [[ "${1:-run}" != "collection-run" ]]; then exit 1; fi
      # Keep the service inspectable instead of restarting its desktop in a loop.
      waiting_pid=''
      trap 'kill "${waiting_pid:-}" 2>/dev/null || true; exit 0' TERM INT
      while true; do sleep 15 & waiting_pid=$!; wait "$waiting_pid" || true; done
    fi
    export COLLECTION_FLOCK_HELD=1
    ;;
esac

# Standby needs no desktop, VNC server or browser process.
if [[ ( "${1:-run}" == "run" || "${1:-run}" == "once" ) && "${PACK_OPENING_ENABLED:-false}" != "true" ]]; then
  exec node /app/src/index.mjs "$@"
fi

# Control commands need neither the desktop nor another browser instance.
case "${1:-run}" in
  collection-status|collection-report|collection-resume|collection-unlock|relabel-status|relabel-report|relabel-resume)
    exec node /app/src/index.mjs "$@" ;;
esac
if [[ "${1:-run}" == "resume" || "${1:-run}" == "status" || "${1:-run}" == "use-manual-session" || "${1:-run}" == "market-demo" || "${1:-run}" == "market-compare" || "${1:-run}" == "market-status" || "${1:-run}" == "market-report" || "${1:-run}" == "market-resume" || "${1:-run}" == "market-unlock" ]]; then
  exec node /app/src/index.mjs "$@"
fi

pids=()
node_pid=''
cleanup() {
  trap - TERM INT EXIT
  # Close Chromium before tearing down its X server so the profile can flush.
  if [[ -n "$node_pid" ]]; then
    kill -TERM "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
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
node_pid=$!

set +e
wait -n "${pids[@]}" "$node_pid"
result=$?
set -e
exit "$result"
