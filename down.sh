#!/usr/bin/env bash
set -euo pipefail

echo "→ Stopping deployed app containers..."
deployed=$(docker ps -q --filter "label=deployable.app" 2>/dev/null || true)
if [ -n "$deployed" ]; then
  echo "$deployed" | xargs docker stop --time 5
  echo "$deployed" | xargs docker rm -f
  echo "  Done."
else
  echo "  None running."
fi

echo "→ Bringing down compose stack..."
docker compose down "$@"
