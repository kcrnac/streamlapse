import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.ffmpeg_binary import (
    _verified_bundled_ffmpeg_exe,
    _verified_stream_ffmpeg_exe,
    _verify_digest,
    verified_ffmpeg_exe,
    verified_stream_ffmpeg_exe,
)


class VerifiedFfmpegTests(unittest.TestCase):
    @patch("scripts.ffmpeg_binary._platform_key", return_value=("windows", "amd64"))
    def test_resolves_the_verified_windows_bundled_executable(self, _platform):
        _verified_bundled_ffmpeg_exe.cache_clear()
        try:
            executable = Path(verified_ffmpeg_exe())
            self.assertTrue(executable.is_file())
            self.assertEqual(executable.parent.name, "binaries")
        finally:
            _verified_bundled_ffmpeg_exe.cache_clear()

    @patch("scripts.ffmpeg_binary._verify_digest")
    @patch("scripts.ffmpeg_binary.Path.is_file", return_value=True)
    @patch("scripts.ffmpeg_binary._platform_key", return_value=("linux", "x86_64"))
    def test_resolves_the_pinned_linux_stream_executable(
        self,
        _platform,
        _is_file,
        verify_digest,
    ):
        _verified_stream_ffmpeg_exe.cache_clear()
        try:
            executable = Path(verified_stream_ffmpeg_exe())
            self.assertEqual(executable.name, "ffmpeg")
            self.assertEqual(executable.parent.name, "ffmpeg")
            verify_digest.assert_called_once()
        finally:
            _verified_stream_ffmpeg_exe.cache_clear()

    def test_rejects_environment_overrides(self):
        with patch.dict(os.environ, {"IMAGEIO_FFMPEG_EXE": "unverified-ffmpeg"}):
            with self.assertRaisesRegex(RuntimeError, "overrides are disabled"):
                verified_ffmpeg_exe()
            with self.assertRaisesRegex(RuntimeError, "overrides are disabled"):
                verified_stream_ffmpeg_exe()

    def test_rejects_a_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = Path(temp_dir) / "ffmpeg"
            candidate.write_bytes(b"not the pinned binary")

            with self.assertRaisesRegex(RuntimeError, "failed SHA-256 verification"):
                _verify_digest(candidate, "0" * 64)


if __name__ == "__main__":
    unittest.main()
