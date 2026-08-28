#!/bin/bash
# Must run before any session/port cleanup. No service or dependency startup here.
set -eu
ROOT_DIR="${1:?Repository root required}"
shift
ROOT_DIR="$(cd "$ROOT_DIR" && pwd -P)"
IS_DEVELOPMENT=false
if [ "$(basename "$ROOT_DIR")" = "Shannon-dev" ] || [ -f "$ROOT_DIR/.shannon-development" ]; then
    IS_DEVELOPMENT=true
fi
if [ "$IS_DEVELOPMENT" = true ] && [ "${1:-}" != "--dev" ]; then
    echo "Refusing production-mode startup from a development checkout. Use --dev." >&2
    exit 2
fi
if [ -f "$ROOT_DIR/.dev-runtime-lock" ]; then
    echo "Development runtime is locked: shared external credentials have not been cleared for live testing. Offline tests/builds are allowed; do not start bots yet." >&2
    exit 3
fi
