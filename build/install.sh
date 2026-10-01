#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'nanosync installer supports Linux x86_64 only.' >&2
  exit 1
fi

for command in curl sha256sum mktemp chmod mv; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

version=${NANOSYNC_VERSION:-latest}
if [[ $version != latest && ! $version =~ ^v[0-9][a-zA-Z0-9._-]*$ ]]; then
  echo 'NANOSYNC_VERSION must be a v-prefixed release tag (for example, v1.0.0).' >&2
  exit 1
fi

install_dir=${NANOSYNC_INSTALL_DIR:-"$HOME/.local/bin"}
asset=nanosync-linux-x64
base_url=https://github.com/FireSquid6/nanosync/releases
if [[ $version == latest ]]; then
  base_url+=/latest/download
else
  base_url+="/download/$version"
fi

mkdir -p -- "$install_dir"
tmp_dir=$(mktemp -d "$install_dir/.nanosync-install.XXXXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT

for file in "$asset" "$asset.sha256"; do
  if ! curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --output "$tmp_dir/$file" "$base_url/$file"; then
    echo "Failed to download $file from $base_url (is the release published?)." >&2
    exit 1
  fi
done

# Accept exactly the sha256sum output for the expected asset, not arbitrary paths.
checksum_line=$(cat "$tmp_dir/$asset.sha256")
if [[ ! $checksum_line =~ ^[0-9a-f]{64}\ \ $asset$ ]]; then
  echo 'Invalid release checksum file.' >&2
  exit 1
fi
if ! (cd "$tmp_dir" && sha256sum --check --status "$asset.sha256"); then
  echo 'nanosync download failed SHA-256 verification.' >&2
  exit 1
fi

chmod 755 "$tmp_dir/$asset"
mv -f -- "$tmp_dir/$asset" "$install_dir/nanosync"
echo "Installed nanosync to $install_dir/nanosync"
