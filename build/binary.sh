#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

target="${1:-linux-x64}"
case "$target" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
  *) echo "Unsupported binary target: $target" >&2; exit 1 ;;
esac
output="${2:-dist/nanosync}"
case "$output" in
  dist/nanosync|"dist/nanosync-$target") ;;
  *) echo "Unsupported binary output: $output" >&2; exit 1 ;;
esac
[[ $# -le 2 ]] || { echo 'Usage: binary.sh [target] [output]' >&2; exit 1; }

bun run build:frontend

bun build --compile --target="bun-$target" packages/cli/src/main.ts --outfile "$output"
