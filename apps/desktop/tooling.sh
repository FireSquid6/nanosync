#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
export HUTCH_HOME="$root/.cache/hutch"
bootstrap="$root/.cache/desktop-toolchain"
export ELECTROBUN_HUTCH_BINARY="$bootstrap/hutch-v0.29.0-linux-x64/bin/hutch"
case "${1:-}" in
  prepare|build|run|dev|config) ;;
  *) echo 'Usage: tooling.sh prepare|build|run|dev|config [arguments]' >&2; exit 2 ;;
esac
if [[ "$(uname -sm)" != 'Linux x86_64' ]]; then
  echo 'This spike is validated on Linux x86_64 only' >&2
  exit 1
fi
if [[ ! -x "$ELECTROBUN_HUTCH_BINARY" ]]; then
  mkdir -p "$bootstrap"
  archive="$bootstrap/hutch.tar.gz"
  curl --fail --location --output "$archive" \
    https://github.com/blackboardsh/electrobun/releases/download/v2.0.6/electrobun-hutch-linux-x64.tar.gz
  echo "4aa3c5c7fa24898d8227b087dd393eb2a1463658f0d87e23a72cfe611af83b75  $archive" | sha256sum --check -
  tar -xzf "$archive" -C "$bootstrap"
fi
cd "$root/apps/desktop"
exec bunx --no-install electrobun "$@"
