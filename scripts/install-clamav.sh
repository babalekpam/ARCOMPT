#!/usr/bin/env bash
set -euo pipefail

# The Nix channel's ClamAV is past its supported lifetime. Pin the official
# ClamAV LTS release instead; never install an unverified download.
version=1.4.6
checksum=d3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="$root/.build/clamav-$version"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

curl --fail --location --retry 2 --connect-timeout 20 \
  "https://www.clamav.net/downloads/production/clamav-$version.linux.x86_64.deb" \
  --output "$temporary/clamav.deb"
printf '%s  %s\n' "$checksum" "$temporary/clamav.deb" | sha256sum --check --status
mkdir -p "$temporary/package"
ar p "$temporary/clamav.deb" data.tar.gz | tar -xz -C "$temporary/package"
test -x "$temporary/package/usr/local/bin/freshclam"
test -x "$temporary/package/usr/local/sbin/clamd"
LD_LIBRARY_PATH="$temporary/package/usr/local/lib" \
  "$temporary/package/usr/local/bin/clamscan" --version | grep -q "ClamAV $version"

# Keep only the runtime tools and shared libraries; the development static
# archives alone are hundreds of megabytes and serve no deployment purpose.
rm -rf "$temporary/package/usr/local/include" \
  "$temporary/package/usr/local/share" \
  "$temporary/package/usr/local/lib/pkgconfig"
rm -f "$temporary/package/usr/local/lib/"*.a

# Seed the deployed build with verified signature files. At every runtime
# restart freshclam updates this seed before the API can accept traffic.
mkdir -p "$temporary/package/db"
cat >"$temporary/freshclam.conf" <<EOF
DatabaseDirectory $temporary/package/db
DatabaseOwner $(id -un)
DatabaseMirror database.clamav.net
EOF
LD_LIBRARY_PATH="$temporary/package/usr/local/lib" \
  "$temporary/package/usr/local/bin/freshclam" --config-file="$temporary/freshclam.conf"
test -s "$temporary/package/db/main.cvd"
test -s "$temporary/package/db/daily.cvd"

mkdir -p "$root/.build"
rm -rf "$destination"
mv "$temporary/package" "$destination"
echo "Verified ClamAV $version installed for this build."