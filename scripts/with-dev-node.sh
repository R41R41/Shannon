#!/usr/bin/env bash
# Scoped PATH only. Does not change system Node or nvm's default alias.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [[ "$(basename "$REPO_ROOT")" != Shannon-dev && ! -f "$REPO_ROOT/.shannon-development" ]]; then
  echo 'This wrapper is only for a development checkout.' >&2; exit 2
fi
DEV_NODE_VERSION="$(cat "$REPO_ROOT/.nvmrc")"
DEV_NODE_BIN="${NVM_DIR:-$HOME/.nvm}/versions/node/v${DEV_NODE_VERSION}/bin"
[[ -x "$DEV_NODE_BIN/node" ]] || { echo 'Pinned development Node is not installed.' >&2; exit 2; }
export PATH="$DEV_NODE_BIN:$PATH"
exec "$@"
