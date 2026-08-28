#!/usr/bin/env bash
set -euo pipefail

# Pinned BtbN build known to handle the HLS/MPEG-TS stream used by capture.py.
release="autobuild-2026-08-27-16-45"
archive_name="ffmpeg-n8.1.2-47-g156bb4d299-linux64-gpl-8.1.tar.xz"
archive_sha256="5422737149e93e157bd736b699be798e1f6d9ecbd97751a761e2518593004a89"
binary_sha256="90f0f2d8326a62da86a94548a1bfa255140934512af8c32d39a07499da0ea4c3"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
install_dir="${repo_root}/.cache/ffmpeg"
executable="${install_dir}/ffmpeg"

if [[ -f "${executable}" ]] && echo "${binary_sha256}  ${executable}" | sha256sum --check --status; then
  echo "Verified cached FFmpeg: ${executable}"
  exit 0
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
archive="${temp_dir}/${archive_name}"
url="https://github.com/BtbN/FFmpeg-Builds/releases/download/${release}/${archive_name}"

curl --fail --location --retry 3 --output "${archive}" "${url}"
echo "${archive_sha256}  ${archive}" | sha256sum --check --status

mkdir -p "${install_dir}"
tar -xf "${archive}" --strip-components=2 -C "${install_dir}" --wildcards '*/bin/ffmpeg'
chmod 755 "${executable}"
echo "${binary_sha256}  ${executable}" | sha256sum --check --status
echo "Installed and verified FFmpeg: ${executable}"
