#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
# macOS TMPDIR can pass through /var -> /private/var; fixtures use physical paths.
tmp=$(cd "$tmp" && pwd -P)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/mock-bin" "$tmp/assets"
if command -v sha256sum >/dev/null 2>&1; then
  TEST_NATIVE_HASH=$(command -v sha256sum)
  export TEST_NATIVE_HASH TEST_NATIVE_HASH_KIND=sha256sum
  fixture_hash=("$TEST_NATIVE_HASH")
else
  TEST_NATIVE_HASH=$(command -v shasum)
  export TEST_NATIVE_HASH TEST_NATIVE_HASH_KIND=shasum
  fixture_hash=("$TEST_NATIVE_HASH" -a 256)
fi
cat > "$tmp/mock-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
output='' url='' writeout='' proto='' redir=''
while (( $# )); do
  case $1 in
    --output) output=$2; shift 2;;
    --write-out) writeout=$2; shift 2;;
    --proto) proto=$2; shift 2;;
    --proto-redir) redir=$2; shift 2;;
    https:*) url=$1; shift;;
    *) shift;;
  esac
done
[[ $proto == '=https' && $redir == '=https' ]] || exit 24
[[ ${TEST_NETWORK_FAIL:-0} != 1 ]] || exit 22
if [[ -n ${TEST_CURL_HOOK:-} && $url == */nanosync-linux-x64.sha256 ]]; then bash "$TEST_CURL_HOOK"; fi
if [[ $url == https://github.com/FireSquid6/nanosync/releases/latest ]]; then
  printf '%s' "${TEST_LATEST_URL:-https://github.com/FireSquid6/nanosync/releases/tag/v1.2.3}"
else
  [[ $url == "https://github.com/FireSquid6/nanosync/releases/download/${TEST_TAG:-v1.2.3}/"* ]] || exit 23
  cp "$TEST_ASSETS/${url##*/}" "$output"
fi
EOF
cat > "$tmp/mock-bin/uname" <<'EOF'
#!/usr/bin/env bash
case $1 in -s) echo "${TEST_OS:-Linux}";; -m) echo "${TEST_ARCH:-x86_64}";; esac
EOF
chmod +x "$tmp/mock-bin/"*
for asset in nanosync-linux-x64 nanosync-linux-arm64 nanosync-darwin-x64 nanosync-darwin-arm64; do
  printf '#!/bin/sh\necho %s\n' "$asset" > "$tmp/assets/$asset"
  (cd "$tmp/assets" && "${fixture_hash[@]}" "$asset" > "$asset.sha256")
done
# Exercise both hash command interfaces on every host, backed by its native tool.
cat > "$tmp/mock-bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${0##*/} == shasum ]]; then
  [[ $# == 3 && $1 == -a && $2 == 256 ]] || exit 1
  shift 2
fi
if [[ $TEST_NATIVE_HASH_KIND == shasum ]]; then
  exec "$TEST_NATIVE_HASH" -a 256 "$@"
else
  exec "$TEST_NATIVE_HASH" "$@"
fi
EOF
cp "$tmp/mock-bin/sha256sum" "$tmp/mock-bin/shasum"
chmod +x "$tmp/mock-bin/sha256sum" "$tmp/mock-bin/shasum"
ln -s "$BASH" "$tmp/mock-bin/bash"
for tool in mkdir mktemp chmod mv rm cat cmp cp grep find ln readlink; do
  if command -v "$tool" >/dev/null 2>&1; then ln -s "$(command -v "$tool")" "$tmp/mock-bin/$tool"; fi
done
export PATH="$tmp/mock-bin" TEST_ASSETS="$tmp/assets" TEST_LOG="$tmp/curl.log"
export HOME="$tmp/home" XDG_STATE_HOME="$tmp/state"
mkdir -p "$HOME"
: > "$TEST_LOG"
bash "$repo_root/build/install.sh" > "$tmp/output" 2>&1 || { cat "$tmp/output"; exit 1; }
[[ $("$HOME/.local/bin/nanosync") == nanosync-linux-x64 ]]
[[ $(grep -c '/releases/latest$' "$TEST_LOG") == 1 ]]
[[ $(grep -c '/download/v1.2.3/' "$TEST_LOG") == 2 ]]
# The downloaded scripts are inert fixtures; no release binary or network is used.
run_installer() {
  bash "$repo_root/build/install.sh" "$@" > "$tmp/output" 2>&1 || { cat "$tmp/output"; return 1; }
}
expect_failure() {
  if bash "$repo_root/build/install.sh" "$@" > "$tmp/output" 2>&1; then
    echo "Unexpected installer success: $*" >&2; exit 1
  fi
}
fresh() {
  case_number=$((case_number + 1))
  export HOME="$tmp/home-$case_number" XDG_STATE_HOME="$tmp/state-$case_number"
  export PATH="$tmp/mock-bin"
  unset NANOSYNC_VERSION NANOSYNC_INSTALL_DIR TEST_OS TEST_ARCH TEST_LATEST_URL TEST_TAG TEST_NETWORK_FAIL TEST_CURL_HOOK
  mkdir -p "$HOME"
  : > "$TEST_LOG"
}
assert_clean() {
  [[ -z $(find "$HOME" "$XDG_STATE_HOME" -name '.nanosync-install.*' -o -name '.stage.*') ]]
}
case_number=0
for target in 'Linux x86_64 linux-x64' 'Linux aarch64 linux-arm64' 'Darwin x86_64 darwin-x64' 'Darwin arm64 darwin-arm64'; do
  fresh
  read -r TEST_OS TEST_ARCH suffix <<< "$target"
  export TEST_OS TEST_ARCH
  run_installer
  [[ $("$HOME/.local/bin/nanosync") == nanosync-$suffix ]]
  assert_clean
  if [[ $TEST_OS == Darwin ]]; then grep -q 'untested' "$tmp/output"; fi
  grep -q 'PATH' "$tmp/output"
  grep -q 'Restart' "$tmp/output"
done
fresh
TEST_OS=FreeBSD expect_failure
[[ ! -e $HOME/.local ]]
TEST_ARCH=riscv64 expect_failure
[[ ! -e $HOME/.local ]]
for version in ../main v01.2.3 v1.02.3 v1.2 v1.2.3-01 v1.2.3-a..b v1.2.3+ v1.2.3/evil; do
  NANOSYNC_VERSION=$version expect_failure
  [[ ! -e $HOME/.local ]]
done
expect_failure --unknown
expect_failure positional
run_installer --help
[[ ! -e $HOME/.local ]]

# Pinning, updates, custom directories, SemVer precedence, adoption.
fresh
export NANOSYNC_INSTALL_DIR="$HOME/custom bin" NANOSYNC_VERSION=v1.2.3-rc.1+build.4 TEST_TAG=v1.2.3-rc.1+build.4
run_installer
[[ $("$NANOSYNC_INSTALL_DIR/nanosync") == nanosync-linux-x64 ]]
[[ $(grep -c '/releases/latest$' "$TEST_LOG" || :) == 0 ]]
export NANOSYNC_VERSION=v1.2.3 TEST_TAG=v1.2.3
run_installer
# Updating the active installer-owned PATH destination is allowed.
PATH="$NANOSYNC_INSTALL_DIR:$PATH" run_installer
NANOSYNC_VERSION=v1.2.2 TEST_TAG=v1.2.2 expect_failure
grep -q 'downgrade' "$tmp/output"
NANOSYNC_VERSION=v1.2.2 TEST_TAG=v1.2.2 run_installer --allow-downgrade
for pair in 'v2.0.0 v1.99.99' 'v1.0.0 v1.0.0-rc.9' 'v1.0.0-rc.10 v1.0.0-rc.2' 'v1.0.0-beta v1.0.0-9' 'v1.0.0-a.b v1.0.0-a' 'v999999999999999999999.0.0 v999999999999999999998.0.0'; do
  fresh
  read -r high low <<< "$pair"
  NANOSYNC_VERSION=$high TEST_TAG=$high run_installer
  NANOSYNC_VERSION=$low TEST_TAG=$low expect_failure
  grep -q 'downgrade' "$tmp/output"
done
fresh
mkdir -p "$HOME/.local/bin"
printf 'old manual installation\n' > "$HOME/.local/bin/nanosync"
expect_failure
[[ $(cat "$HOME/.local/bin/nanosync") == 'old manual installation' ]]
run_installer --adopt-existing
grep -q 'previous version is unknown' "$tmp/output"
run_installer

# Ownership checks are never weakened by --no-verify or --adopt-existing.
printf 'modified\n' >> "$HOME/.local/bin/nanosync"
cp "$HOME/.local/bin/nanosync" "$tmp/protected"
expect_failure --no-verify --adopt-existing
cmp -s "$HOME/.local/bin/nanosync" "$tmp/protected"
assert_clean
fresh
mkdir -p "$HOME/.local/bin"
ln -s "$tmp/protected" "$HOME/.local/bin/nanosync"
expect_failure --adopt-existing
[[ -L $HOME/.local/bin/nanosync ]]
fresh
mkdir -p "$HOME/real"
ln -s "$HOME/real" "$HOME/.local"
expect_failure
[[ ! -e $HOME/real/bin ]]
fresh
mkdir -p "$XDG_STATE_HOME"
ln -s "$HOME" "$XDG_STATE_HOME/nanosync-installer"
expect_failure
fresh
NANOSYNC_INSTALL_DIR=relative expect_failure
NANOSYNC_INSTALL_DIR="$HOME/../other" expect_failure
fresh
run_installer
receipt_files=("$XDG_STATE_HOME/nanosync-installer/"*.receipt)
receipt=${receipt_files[0]}
printf 'extra\n' >> "$receipt"
expect_failure --adopt-existing
grep -q 'receipt' "$tmp/output"
fresh
run_installer
rm "$HOME/.local/bin/nanosync"
expect_failure --adopt-existing
grep -q 'Receipt exists' "$tmp/output"
fresh
run_installer
receipt_files=("$XDG_STATE_HOME/nanosync-installer/"*.receipt)
receipt=${receipt_files[0]}
rm "$receipt"
ln -s "$tmp/protected" "$receipt"
expect_failure

# Do not shadow or adopt executables from another installation method.
fresh
mkdir -p "$HOME/unknown-bin"
cp "$tmp/protected" "$HOME/unknown-bin/nanosync"
chmod +x "$HOME/unknown-bin/nanosync"
PATH="$HOME/unknown-bin:$PATH" expect_failure --adopt-existing
grep -q 'Unknown nanosync provenance' "$tmp/output"
cmp -s "$HOME/unknown-bin/nanosync" "$tmp/protected"
mkdir -p "$HOME/.nix-profile/bin"
cp "$HOME/unknown-bin/nanosync" "$HOME/.nix-profile/bin/nanosync"
PATH="$HOME/.nix-profile/bin:$PATH" expect_failure
grep -q 'Nix' "$tmp/output"
mkdir -p "$HOME/Cellar" "$HOME/.local/bin"
cp "$HOME/unknown-bin/nanosync" "$HOME/Cellar/nanosync"
ln -s ../../Cellar/nanosync "$HOME/.local/bin/nanosync"
PATH="$HOME/.local/bin:$PATH" expect_failure
grep -q 'Homebrew' "$tmp/output"
rm "$HOME/.local/bin/nanosync"
cat > "$tmp/mock-bin/dpkg-query" <<'EOF'
#!/usr/bin/env bash
[[ $1 == -S && $2 == */nanosync ]]
EOF
chmod +x "$tmp/mock-bin/dpkg-query"
PATH="$HOME/unknown-bin:$PATH" expect_failure --adopt-existing
grep -q 'package manager' "$tmp/output"
rm "$tmp/mock-bin/dpkg-query"
fresh
run_installer
cat > "$tmp/mock-bin/rpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/mock-bin/rpm"
PATH="$HOME/.local/bin:$PATH" expect_failure --adopt-existing
grep -q 'package manager' "$tmp/output"
# A package-owned destination is protected even when it is not on PATH.
expect_failure --adopt-existing
grep -q 'package manager' "$tmp/output"
rm "$tmp/mock-bin/rpm"
fresh
mkdir -p "$HOME/.local/bin"
printf 'manual-looking package file\n' > "$HOME/.local/bin/nanosync"
cat > "$tmp/mock-bin/pacman" <<'EOF'
#!/usr/bin/env bash
[[ $1 == -Qo && $2 == "$HOME/.local/bin/nanosync" ]]
EOF
chmod +x "$tmp/mock-bin/pacman"
expect_failure
grep -q 'package manager' "$tmp/output"
expect_failure --adopt-existing
grep -q 'package manager' "$tmp/output"
[[ $(cat "$HOME/.local/bin/nanosync") == 'manual-looking package file' ]]
rm "$tmp/mock-bin/pacman"

# All pre-replacement failures retain both the binary and receipt.
fresh
run_installer
cp "$HOME/.local/bin/nanosync" "$tmp/protected"
receipt_files=("$XDG_STATE_HOME/nanosync-installer/"*.receipt)
receipt=${receipt_files[0]}
cp "$receipt" "$tmp/protected-receipt"
assert_preserved() {
  cmp -s "$HOME/.local/bin/nanosync" "$tmp/protected"
  cmp -s "$receipt" "$tmp/protected-receipt"
  assert_clean
}
TEST_NETWORK_FAIL=1 expect_failure
assert_preserved
cp "$TEST_ASSETS/nanosync-linux-x64.sha256" "$tmp/checksum"
for checksum in 'bad' '0000000000000000000000000000000000000000000000000000000000000000  nanosync-linux-x64' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  nanosync-linux-x64'; do
  printf '%s\n' "$checksum" > "$TEST_ASSETS/nanosync-linux-x64.sha256"
  expect_failure
  assert_preserved
done
cp "$tmp/checksum" "$TEST_ASSETS/nanosync-linux-x64.sha256"
printf '\n' >> "$TEST_ASSETS/nanosync-linux-x64.sha256"
expect_failure
assert_preserved
# Correct line without its required final newline also fails.
checksum=$(cat "$tmp/checksum")
printf '%s' "$checksum" > "$TEST_ASSETS/nanosync-linux-x64.sha256"
expect_failure
assert_preserved
printf '%s\n' "${checksum/nanosync-linux-x64/other-asset}" > "$TEST_ASSETS/nanosync-linux-x64.sha256"
expect_failure
assert_preserved
rm "$TEST_ASSETS/nanosync-linux-x64.sha256"
expect_failure
assert_preserved
: > "$TEST_LOG"
run_installer --no-verify
grep -q 'WARNING: --no-verify' "$tmp/output"
[[ $(grep -c '\.sha256' "$TEST_LOG" || :) == 0 ]]
cp "$tmp/checksum" "$TEST_ASSETS/nanosync-linux-x64.sha256"
mv "$TEST_ASSETS/nanosync-linux-x64" "$tmp/binary"
expect_failure
assert_preserved
mv "$tmp/binary" "$TEST_ASSETS/nanosync-linux-x64"
for resolved in 'https://example.com/tag/v1.2.3' 'https://github.com/FireSquid6/nanosync/releases/tag/v1.2.3-rc.1' 'https://github.com/FireSquid6/nanosync/releases/tag/v01.2.3'; do
  TEST_LATEST_URL=$resolved expect_failure
  assert_preserved
done
mkdir "$HOME/.local/bin/.nanosync-install.lock"
expect_failure
grep -q 'locked' "$tmp/output"
[[ -d $HOME/.local/bin/.nanosync-install.lock ]]
rm -rf "$HOME/.local/bin/.nanosync-install.lock"
assert_preserved

# Hash tools are platform alternatives, not a --no-verify escape hatch.
mv "$tmp/mock-bin/sha256sum" "$tmp/sha256sum-link"
run_installer
run_installer --no-verify
mv "$tmp/mock-bin/shasum" "$tmp/shasum-link"
expect_failure --no-verify
grep -q 'hash tool' "$tmp/output"
assert_preserved
mv "$tmp/sha256sum-link" "$tmp/mock-bin/sha256sum"
mv "$tmp/shasum-link" "$tmp/mock-bin/shasum"
for tool in curl mktemp chmod mv cmp; do
  mv "$tmp/mock-bin/$tool" "$tmp/tool-link"
  expect_failure
  grep -q 'Missing required command' "$tmp/output"
  # mv itself may currently be hidden from PATH.
  /bin/mv "$tmp/tool-link" "$tmp/mock-bin/$tool"
  assert_preserved
done
# Exact receipt format and destination association are required, not sourced as shell.
for corruption in destination version hash truncated executable; do
  fresh
  run_installer
  receipt_files=("$XDG_STATE_HOME/nanosync-installer/"*.receipt)
  receipt=${receipt_files[0]}
  case $corruption in
    destination) printf '%s\nv1.2.3\n%s\n' "$HOME/elsewhere/nanosync" "$(sha256sum "$HOME/.local/bin/nanosync" | { read -r digest rest; echo "$digest"; })" > "$receipt";;
    version) printf '%s\nnot-semver\n%s\n' "$HOME/.local/bin/nanosync" "$(sha256sum "$HOME/.local/bin/nanosync" | { read -r digest rest; echo "$digest"; })" > "$receipt";;
    hash) printf '%s\nv1.2.3\n%064d\n' "$HOME/.local/bin/nanosync" 0 > "$receipt";;
    truncated) printf '%s\nv1.2.3\n' "$HOME/.local/bin/nanosync" > "$receipt";;
    executable) printf 'touch %s\n' "$HOME/receipt-executed" > "$receipt";;
  esac
  cp "$HOME/.local/bin/nanosync" "$tmp/protected"
  expect_failure --adopt-existing --no-verify
  cmp -s "$HOME/.local/bin/nanosync" "$tmp/protected"
  [[ ! -e $HOME/receipt-executed ]]
  assert_clean
done

# The lock also rejects a second installer during a download, without timing races.
fresh
cat > "$tmp/reenter" <<'EOF'
#!/usr/bin/env bash
if bash "$TEST_INSTALLER" > "$HOME/second-output" 2>&1; then exit 1; fi
grep -q 'locked' "$HOME/second-output"
EOF
export TEST_INSTALLER="$repo_root/build/install.sh"
TEST_CURL_HOOK="$tmp/reenter" run_installer
assert_clean

# Detect a destination or receipt changed by another actor before the final rename.
for changed in destination receipt; do
  fresh
  run_installer
  cp "$HOME/.local/bin/nanosync" "$tmp/protected"
  if [[ $changed == destination ]]; then
    cat > "$tmp/change-hook" <<'EOF'
printf 'external change\n' > "$HOME/.local/bin/nanosync"
EOF
  else
    cat > "$tmp/change-hook" <<'EOF'
printf 'external change\n' >> "$XDG_STATE_HOME"/nanosync-installer/*.receipt
EOF
  fi
  TEST_CURL_HOOK="$tmp/change-hook" expect_failure
  grep -q 'changed during installation' "$tmp/output"
  if [[ $changed == destination ]]; then
    [[ $(cat "$HOME/.local/bin/nanosync") == 'external change' ]]
  else
    cmp -s "$HOME/.local/bin/nanosync" "$tmp/protected"
  fi
  assert_clean
done

# An error after binary rename cannot be rolled back atomically with its receipt.
# The mismatch must be refused on the next run, even with adoption/no-verify.
fresh
run_installer
cp "$TEST_ASSETS/nanosync-linux-x64" "$tmp/original-asset"
cp "$TEST_ASSETS/nanosync-linux-x64.sha256" "$tmp/original-checksum"
printf '#!/bin/sh\necho updated-fixture\n' > "$TEST_ASSETS/nanosync-linux-x64"
(cd "$TEST_ASSETS" && sha256sum nanosync-linux-x64 > nanosync-linux-x64.sha256)
mkdir -p "$tmp/real-tools"
mv "$tmp/mock-bin/mv" "$tmp/real-tools/mv"
cat > "$tmp/mock-bin/mv" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do [[ $arg != *.receipt ]] || exit 1; done
exec "$TEST_REAL_MV" "$@"
EOF
chmod +x "$tmp/mock-bin/mv"
export TEST_REAL_MV="$tmp/real-tools/mv"
NANOSYNC_VERSION=v1.2.4 TEST_TAG=v1.2.4 expect_failure
grep -q 'receipt update failed' "$tmp/output" || { cat "$tmp/output"; exit 1; }
[[ $("$HOME/.local/bin/nanosync") == updated-fixture ]]
rm "$tmp/mock-bin/mv"
/bin/mv "$tmp/real-tools/mv" "$tmp/mock-bin/mv"
expect_failure --adopt-existing --no-verify
grep -q 'inconsistent receipt' "$tmp/output"
assert_clean
cp "$tmp/original-asset" "$TEST_ASSETS/nanosync-linux-x64"
cp "$tmp/original-checksum" "$TEST_ASSETS/nanosync-linux-x64.sha256"

# Staging and final binary-rename errors before replacement preserve the old copy.
fresh
run_installer
cp "$HOME/.local/bin/nanosync" "$tmp/protected"
receipt_files=("$XDG_STATE_HOME/nanosync-installer/"*.receipt)
receipt=${receipt_files[0]}
cp "$receipt" "$tmp/protected-receipt"
for tool in mktemp chmod mv sha256sum; do
  mv "$tmp/mock-bin/$tool" "$tmp/real-tool"
  printf '#!/bin/sh\nexit 1\n' > "$tmp/mock-bin/$tool"
  /bin/chmod +x "$tmp/mock-bin/$tool"
  expect_failure
  /bin/rm "$tmp/mock-bin/$tool"
  /bin/mv "$tmp/real-tool" "$tmp/mock-bin/$tool"
  assert_preserved
done
echo 'Installer fixture tests passed (four target selections; no network or macOS runtime execution).'
