#!/usr/bin/env bash
# Compatible with macOS Bash 3.2. Never execute the downloaded binary here.
set -euo pipefail
umask 077
export LC_ALL=C
fail() { printf 'nanosync installer: %s\n' "$*" >&2; exit 1; }
verify=1
adopt=0
allow_downgrade=0
for arg in "$@"; do
  case $arg in
    --no-verify) verify=0;;
    --adopt-existing) adopt=1;;
    --allow-downgrade) allow_downgrade=1;;
    --help) echo 'Usage: bash install.sh [--no-verify] [--adopt-existing] [--allow-downgrade]'; exit 0;;
    *) fail "Unknown argument: $arg";;
  esac
done
for tool in uname curl mkdir mktemp chmod mv rm cmp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Missing required command: $tool (install it yourself, then retry)."
done
if command -v sha256sum >/dev/null 2>&1; then
  hash_command=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  hash_command=(shasum -a 256)
else
  fail 'Missing required hash tool: sha256sum or shasum (required even with --no-verify).'
fi
hash_file() {
  local result
  result=$("${hash_command[@]}" "$1") || fail 'Local hashing failed.'
  result=${result%% *}
  [[ $result =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid local SHA-256 output.'
  printf '%s' "$result"
}
case $(uname -s) in Linux) os=linux;; Darwin) os=darwin;; *) fail 'Unsupported operating system (Linux/macOS only).';; esac
case $(uname -m) in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail 'Unsupported architecture (x86-64/ARM64 only).';; esac
asset=nanosync-$os-$arch
# SemVer numeric identifiers cannot have leading zeroes, including prereleases.
valid_version() {
  local version=$1 prerelease identifier
  [[ $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]] || return 1
  version=${version%%+*}
  if [[ $version == *-* ]]; then
    prerelease=${version#*-}
    local parts
    IFS=. read -r -a parts <<< "$prerelease"
    for identifier in "${parts[@]}"; do
      [[ ! $identifier =~ ^[0-9]+$ || $identifier == 0 || $identifier != 0* ]] || return 1
    done
  fi
}
# Compare arbitrary-size decimal strings without shell integer overflow.
number_less() {
  [[ ${#1} -lt ${#2} || ( ${#1} -eq ${#2} && $1 < $2 ) ]]
}
version_less() {
  local left=${1#v} right=${2#v} index first second
  local left_core right_core left_pre right_pre left_parts right_parts
  left=${left%%+*}; right=${right%%+*}
  left_core=${left%%-*}; right_core=${right%%-*}
  IFS=. read -r -a left_parts <<< "$left_core"
  IFS=. read -r -a right_parts <<< "$right_core"
  for index in 0 1 2; do
    first=${left_parts[$index]}; second=${right_parts[$index]}
    if [[ $first != "$second" ]]; then number_less "$first" "$second"; return; fi
  done
  [[ $left == *-* ]] || return 1
  [[ $right == *-* ]] || return 0
  left_pre=${left#*-}; right_pre=${right#*-}
  IFS=. read -r -a left_parts <<< "$left_pre"
  IFS=. read -r -a right_parts <<< "$right_pre"
  for ((index=0; index<${#left_parts[@]}; index++)); do
    [[ $index -lt ${#right_parts[@]} ]] || return 1
    first=${left_parts[$index]}; second=${right_parts[$index]}
    [[ $first != "$second" ]] || continue
    if [[ $first =~ ^[0-9]+$ && $second =~ ^[0-9]+$ ]]; then
      number_less "$first" "$second"; return
    elif [[ $first =~ ^[0-9]+$ ]]; then return 0
    elif [[ $second =~ ^[0-9]+$ ]]; then return 1
    else [[ $first < $second ]]; return
    fi
  done
  [[ ${#left_parts[@]} -lt ${#right_parts[@]} ]]
}
version=${NANOSYNC_VERSION:-latest}
[[ $version == latest ]] || valid_version "$version" || fail 'NANOSYNC_VERSION must be a strict v-prefixed SemVer tag (for example v1.2.3 or v1.2.3-rc.1).'
install_dir=${NANOSYNC_INSTALL_DIR:-"$HOME/.local/bin"}
state_dir=${XDG_STATE_HOME:-"$HOME/.local/state"}/nanosync-installer
# Reject ambiguous paths and every symlink component, including dangling links.
safe_path() {
  local path=$1 current='' component components
  [[ $path == /* && $path != *$'\n'* && $path != *$'\r'* ]] || fail 'Installation/state paths must be absolute and contain no newlines.'
  IFS=/ read -r -a components <<< "$path"
  for component in "${components[@]}"; do
    [[ -n $component ]] || continue
    [[ $component != . && $component != .. ]] || fail 'Installation/state paths must not contain . or .. components.'
    current=$current/$component
    [[ ! -L $current ]] || fail "Refusing symlink path: $current"
  done
}
safe_path "$install_dir"
safe_path "$state_dir"
# Canonical spelling associates exactly one receipt with each destination.
mkdir -p -- "$install_dir" "$state_dir"
install_dir=$(cd "$install_dir" && pwd -P)
state_dir=$(cd "$state_dir" && pwd -P)
[[ -O $install_dir && -O $state_dir ]] || fail 'Installation and receipt directories must be owned by the current user.'
destination=$install_dir/nanosync
# PATH is a separate trust boundary: adoption never authorizes another executable.
active=$(command -v nanosync || :)
for candidate in "$active" "$destination"; do
  [[ -n $candidate ]] || continue
  case $candidate in
    /nix/*|*/.nix-profile/*|*/profiles/*) fail 'Nix-managed nanosync detected. Update it using Nix, not this installer.';;
    /opt/homebrew/*|/usr/local/Cellar/*|/home/linuxbrew/*) fail 'Homebrew nanosync detected. Update it using brew.';;
  esac
  if command -v readlink >/dev/null 2>&1; then
    active_target=$(readlink "$candidate" 2>/dev/null || :)
    case $active_target in
      /nix/*|*Cellar/*) fail 'Package-managed nanosync detected. Update it using Nix or Homebrew.';;
    esac
  fi
  for manager in dpkg-query rpm pacman; do
    if command -v "$manager" >/dev/null 2>&1; then
      case $manager in
        dpkg-query) manager_args=(-S);; rpm) manager_args=(-qf);; pacman) manager_args=(-Qo);;
      esac
      if "$manager" "${manager_args[@]}" "$candidate" >/dev/null 2>&1; then
        fail "Package-managed nanosync detected. Update it using its package manager ($manager)."
      fi
    fi
  done
done
[[ -z $active || $active == "$destination" ]] || fail "Unknown nanosync provenance on PATH: $active. Remove it from PATH or use its original installation method; nothing was overwritten."
safe_path "$destination"
lock=$install_dir/.nanosync-install.lock
mkdir -- "$lock" 2>/dev/null || fail "Installation is locked: $lock (if a previous installer was interrupted, remove this directory manually after checking no installer is running)."
tmp_dir='' receipt_tmp=''
cleanup() {
  [[ -z $tmp_dir ]] || rm -rf -- "$tmp_dir"
  [[ -z $receipt_tmp ]] || rm -rf -- "$receipt_tmp"
  rm -rf -- "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tmp_dir=$(mktemp -d "$install_dir/.nanosync-install.XXXXXXXX")
receipt_tmp=$(mktemp -d "$state_dir/.stage.XXXXXXXX")
printf '%s\n' "$destination" > "$tmp_dir/destination"
receipt=$state_dir/$(hash_file "$tmp_dir/destination").receipt
safe_path "$receipt"
[[ ! -e $receipt || -f $receipt ]] || fail 'Receipt is not a regular file.'
old_hash='' old_version=''
if [[ -e $destination ]]; then
  [[ -f $destination && -O $destination ]] || fail 'Destination must be a regular file owned by the current user.'
  old_hash=$(hash_file "$destination")
fi
if [[ -e $receipt ]]; then
  [[ -O $receipt ]] || fail 'Ownership receipt is not owned by the current user.'
  [[ -n $old_hash ]] || fail 'Receipt exists but destination is missing; resolve the inconsistent receipt manually.'
  {
    IFS= read -r receipt_destination && IFS= read -r old_version && IFS= read -r receipt_hash
  } < "$receipt" || fail 'Malformed ownership receipt; resolve it manually.'
  [[ $receipt_destination == "$destination" ]] && valid_version "$old_version" && [[ $receipt_hash == "$old_hash" ]] || fail 'Modified destination or inconsistent receipt; restore the owned binary or resolve manually.'
  printf '%s\n%s\n%s\n' "$destination" "$old_version" "$old_hash" > "$tmp_dir/old-receipt"
  cmp -s "$receipt" "$tmp_dir/old-receipt" || fail 'Malformed ownership receipt; resolve it manually.'
elif [[ -n $old_hash && $adopt == 0 ]]; then
  fail 'Unknown destination ownership. For a known receipt-less manual installation, rerun with --adopt-existing; otherwise choose another directory.'
fi
curl_options=(--fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2)
base_url=https://github.com/FireSquid6/nanosync/releases
if [[ $version == latest ]]; then
  # GitHub /latest excludes prereleases; retain its immutable tag, not /latest/download.
  resolved=$(curl "${curl_options[@]}" --output /dev/null --write-out '%{url_effective}' "$base_url/latest") || fail 'Failed to resolve the latest stable release.'
  [[ $resolved == "$base_url/tag/"* ]] || fail 'Latest release resolved outside the expected repository.'
  version=${resolved#"$base_url/tag/"}
  valid_version "$version" && [[ ${version%%+*} != *-* ]] || fail 'Latest release did not resolve to a stable SemVer tag.'
fi
if [[ -n $old_version && $allow_downgrade == 0 ]] && version_less "$version" "$old_version"; then
  fail "Refusing downgrade from $old_version to $version. Use --allow-downgrade intentionally."
fi
base_url=$base_url/download/$version
if [[ -n $old_hash && -z $old_version ]]; then
  echo 'WARNING: adopting a receipt-less manual installation; its previous version is unknown, so this adoption cannot detect a downgrade.' >&2
fi
if [[ $verify == 0 ]]; then
  echo 'WARNING: --no-verify disables published release checksum verification. HTTPS and local ownership hashing remain mandatory.' >&2
fi
curl "${curl_options[@]}" --output "$tmp_dir/$asset" "$base_url/$asset" || fail "Failed to download $asset (is the release published?)."
new_hash=$(hash_file "$tmp_dir/$asset")
if [[ $verify == 1 ]]; then
  curl "${curl_options[@]}" --output "$tmp_dir/$asset.sha256" "$base_url/$asset.sha256" || fail 'Failed to download the required release checksum.'
  printf '%s  %s\n' "$new_hash" "$asset" > "$tmp_dir/expected.sha256"
  cmp -s "$tmp_dir/expected.sha256" "$tmp_dir/$asset.sha256" || fail 'Invalid release checksum format or SHA-256 mismatch.'
fi
chmod 755 "$tmp_dir/$asset"
printf '%s\n%s\n%s\n' "$destination" "$version" "$new_hash" > "$receipt_tmp/receipt"
chmod 600 "$receipt_tmp/receipt"
# Recheck immediately before replacement; an interrupted two-file commit fails closed next run.
safe_path "$destination"
safe_path "$receipt"
if [[ -n $old_hash ]]; then
  [[ -f $destination && $(hash_file "$destination") == "$old_hash" ]] || fail 'Destination changed during installation.'
else
  [[ ! -e $destination ]] || fail 'Destination appeared during installation.'
fi
if [[ -f $tmp_dir/old-receipt ]]; then
  cmp -s "$receipt" "$tmp_dir/old-receipt" || fail 'Receipt changed during installation.'
else
  [[ ! -e $receipt ]] || fail 'Receipt appeared during installation.'
fi
mv -f -- "$tmp_dir/$asset" "$destination"
mv -f -- "$receipt_tmp/receipt" "$receipt" || fail 'Binary installed but receipt update failed. Resolve receipt inconsistency manually before updating again.'
echo "Installed nanosync $version to $destination"
case :$PATH: in
  *:"$install_dir":*) :;;
  *) printf "Add this directory to PATH yourself: export PATH=%q:\"\$PATH\"\n" "$install_dir";;
esac
echo 'Restart any running nanosync client/server manually to use the new executable. No processes or sync state were changed.'
[[ $os != darwin ]] || echo 'macOS binaries are Bun build outputs; macOS runtime behavior is untested.'
