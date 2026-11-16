#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/mock-bin" "$tmp/assets" "$tmp/home"

cat > "$tmp/mock-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while (( $# > 2 )); do
  if [[ $1 == --output ]]; then output=$2; shift 2; else shift; fi
done
[[ $1 == "$TEST_URL_PREFIX"/* ]] || exit 1
file=${1##*/}
[[ -f $TEST_ASSETS/$file ]] || exit 22
cp "$TEST_ASSETS/$file" "$output"
EOF
cat > "$tmp/mock-bin/uname" <<'EOF'
#!/usr/bin/env bash
if [[ $1 == -m && ${TEST_ARCH:-} ]]; then echo "$TEST_ARCH"; else /usr/bin/uname "$@"; fi
EOF
chmod +x "$tmp/mock-bin/curl" "$tmp/mock-bin/uname"

printf '#!/bin/sh\necho fixture-binary\n' > "$tmp/assets/nanosync-linux-x64"
(cd "$tmp/assets" && sha256sum nanosync-linux-x64 > nanosync-linux-x64.sha256)

# Run away from the checkout to exercise stdin installation with no repo/Bun.
cd "$tmp"
export HOME="$tmp/home" PATH="$tmp/mock-bin:$PATH" TEST_ASSETS="$tmp/assets"
export TEST_URL_PREFIX=https://github.com/FireSquid6/nanosync/releases/latest/download
bash "$repo_root/build/install.sh"
[[ $("$HOME/.local/bin/nanosync") == fixture-binary ]]
[[ -z $(find "$HOME/.local/bin" -maxdepth 1 -name '.nanosync-install.*' -print -quit) ]]

export TEST_URL_PREFIX=https://github.com/FireSquid6/nanosync/releases/download/v1.2.3
NANOSYNC_VERSION=v1.2.3 NANOSYNC_INSTALL_DIR="$tmp/custom bin" bash < "$repo_root/build/install.sh"
[[ $("$tmp/custom bin/nanosync") == fixture-binary ]]

printf '%064d  nanosync-linux-x64\n' 0 > "$tmp/assets/nanosync-linux-x64.sha256"
if NANOSYNC_INSTALL_DIR="$tmp/custom bin" bash "$repo_root/build/install.sh" > /dev/null 2>&1; then
  echo 'incorrect digest was accepted' >&2; exit 1
fi
[[ $("$tmp/custom bin/nanosync") == fixture-binary ]]

printf 'incorrect checksum\n' > "$tmp/assets/nanosync-linux-x64.sha256"
if NANOSYNC_INSTALL_DIR="$tmp/custom bin" bash "$repo_root/build/install.sh" > /dev/null 2>&1; then
  echo 'corrupt checksum was accepted' >&2; exit 1
fi
[[ $("$tmp/custom bin/nanosync") == fixture-binary ]]

rm "$tmp/assets/nanosync-linux-x64.sha256"
if bash "$repo_root/build/install.sh" > /dev/null 2>&1; then
  echo 'missing release asset was accepted' >&2; exit 1
fi
if TEST_ARCH=aarch64 bash "$repo_root/build/install.sh" > /dev/null 2>&1; then
  echo 'unsupported architecture was accepted' >&2; exit 1
fi
if NANOSYNC_VERSION='../main' bash "$repo_root/build/install.sh" > /dev/null 2>&1; then
  echo 'unsafe version was accepted' >&2; exit 1
fi
echo 'Installer fixture tests passed.'
