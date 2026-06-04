#!/usr/bin/env bash
# Dev helpers — `npm run stop`, `npm run status`, `npm run restart`.
#
# Single source of truth for "what does the server look like right now",
# so testing cycles don't depend on remembering pkill incantations.

set -euo pipefail

PORT=8888
MATCH='tsx src/server.ts'

# Find the PID currently bound to PORT (LISTEN socket), if any.
port_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# Find every PID whose argv contains MATCH (covers npm wrapper + tsx + node).
match_pids() {
  pgrep -f "$MATCH" 2>/dev/null || true
}

# Wait until the LISTEN socket on PORT is gone, or fail after 5 seconds.
wait_port_free() {
  local deadline=$(( $(date +%s) + 5 ))
  while [ -n "$(port_pid)" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "port $PORT still held after 5s — manual intervention needed" >&2
      return 1
    fi
    sleep 0.2
  done
}

cmd_status() {
  local pid; pid="$(port_pid)"
  if [ -n "$pid" ]; then
    echo "server: RUNNING  port=$PORT  pid=$pid"
    ps -o pid,ppid,etime,command -p "$pid"
  else
    echo "server: stopped  (no LISTEN on $PORT)"
  fi

  local mpids; mpids="$(match_pids)"
  if [ -n "$mpids" ]; then
    echo
    echo "matching processes ('$MATCH'):"
    # shellcheck disable=SC2086
    ps -o pid,ppid,etime,command -p $mpids
  fi
}

cmd_stop() {
  local before; before="$(port_pid)"
  local matches; matches="$(match_pids)"

  if [ -z "$before" ] && [ -z "$matches" ]; then
    echo "nothing to stop"
    return 0
  fi

  echo "stopping…"
  # First polite SIGTERM to every matching process so the npm wrapper, tsx,
  # and the node child all unwind. Then a SIGKILL fallback if anything
  # survives the grace period.
  if [ -n "$matches" ]; then
    # shellcheck disable=SC2086
    kill -TERM $matches 2>/dev/null || true
  fi
  sleep 0.3
  if ! wait_port_free 2>/dev/null; then
    echo "escalating to SIGKILL"
    matches="$(match_pids)"
    if [ -n "$matches" ]; then
      # shellcheck disable=SC2086
      kill -KILL $matches 2>/dev/null || true
    fi
    local hold; hold="$(port_pid)"
    if [ -n "$hold" ]; then
      kill -KILL "$hold" 2>/dev/null || true
    fi
    wait_port_free
  fi
  echo "stopped"
}

cmd_restart() {
  cmd_stop
  echo "starting…"
  # exec so signals (Ctrl-C) reach tsx directly; this blocks the terminal,
  # which is the normal foreground-dev workflow.
  exec npm start
}

main() {
  local sub="${1:-status}"
  case "$sub" in
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    restart) cmd_restart ;;
    *)
      echo "usage: $0 {stop|status|restart}" >&2
      exit 2
      ;;
  esac
}

main "$@"
