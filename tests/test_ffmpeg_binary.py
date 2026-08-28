import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.ffmpeg_binary import _verify_digest, verified_ffmpeg_exe


class VerifiedFfmpegTests(unittest.TestCase):
    def test_resolves_the_verified_bundled_executable(self):
        executable = Path(verified_ffmpeg_exe())
        self.assertTrue(executable.is_file())
        self.assertEqual(executable.parent.name, "binaries")

    def test_rejects_environment_overrides(self):
        with patch.dict(os.environ, {"IMAGEIO_FFMPEG_EXE": "unverified-ffmpeg"}):
            with self.assertRaisesRegex(RuntimeError, "overrides are disabled"):
                verified_ffmpeg_exe()

    def test_rejects_a_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = Path(temp_dir) / "ffmpeg"
            candidate.write_bytes(b"not the pinned binary")

            with self.assertRaisesRegex(RuntimeError, "failed SHA-256 verification"):
                _verify_digest(candidate, "0" * 64)


if __name__ == "__main__":
    unittest.main()
