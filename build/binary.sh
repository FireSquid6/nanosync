#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bun run build:frontend

# Compile the complete CLI (including server and workspace packages) into one Linux executable.
bun build --compile --target=bun-linux-x64 packages/cli/src/main.ts --outfile dist/nanosync
