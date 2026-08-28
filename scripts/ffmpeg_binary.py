"""Resolve and verify the FFmpeg binary bundled by imageio-ffmpeg."""

import hashlib
import hmac
import os
import platform
from functools import lru_cache
from pathlib import Path

import imageio_ffmpeg


# imageio-ffmpeg 0.6.0 binaries from the hash-locked wheels in requirements.txt.
BUNDLED_FFMPEG = {
    ("linux", "x86_64"): (
        "ffmpeg-linux-x86_64-v7.0.2",
        "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
    ),
    ("windows", "amd64"): (
        "ffmpeg-win-x86_64-v7.1.exe",
        "2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3",
    ),
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as binary_file:
        for chunk in iter(lambda: binary_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_digest(path: Path, expected_sha256: str) -> None:
    actual_sha256 = _sha256(path)
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise RuntimeError(
            f"Bundled FFmpeg failed SHA-256 verification: expected {expected_sha256}, "
            f"got {actual_sha256}",
        )


@lru_cache(maxsize=1)
def _verified_bundled_ffmpeg_exe() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine == "x64":
        machine = "amd64"

    binary = BUNDLED_FFMPEG.get((system, machine))
    if not binary:
        raise RuntimeError(f"No verified FFmpeg binary is configured for {system}/{machine}")

    filename, expected_sha256 = binary
    package_dir = Path(imageio_ffmpeg.__file__).resolve().parent
    executable = package_dir / "binaries" / filename
    if not executable.is_file():
        raise RuntimeError(f"Bundled FFmpeg is missing: {executable}")

    _verify_digest(executable, expected_sha256)
    return str(executable)


def verified_ffmpeg_exe() -> str:
    if os.environ.get("IMAGEIO_FFMPEG_EXE"):
        raise RuntimeError(
            "IMAGEIO_FFMPEG_EXE overrides are disabled; use the verified bundled executable",
        )
    return _verified_bundled_ffmpeg_exe()
