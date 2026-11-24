#!/usr/bin/env bash
set -euo pipefail

package=$1
version=$2
build=${BILIMUSIC_BUILD_NUMBER:-1}
[[ "$build" =~ ^([1-9]|[1-4][0-9]|50)$ ]]
target=$version
if (( build > 1 )); then
  target="$version-$build"
fi

current=$(dpkg-deb -f "$package" Version)
if [[ "$current" != "$target" ]]; then
  [[ "$current" == "$version" ]]
  stage=$(mktemp -d "$(dirname "$package")/.debian-version.XXXXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  dpkg-deb --raw-extract "$package" "$stage/root"
  sed -i "s/^Version: .*/Version: $target/" "$stage/root/DEBIAN/control"
  dpkg-deb --root-owner-group -Zgzip --build "$stage/root" "$stage/package.deb" >&2
  [[ $(dpkg-deb -f "$stage/package.deb" Version) == "$target" ]]
  mv -- "$stage/package.deb" "$package"
fi
printf '%s\n' "$target"
