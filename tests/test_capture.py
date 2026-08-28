import io
import subprocess
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from scripts.capture import capture_frame


class CaptureDiagnosticsTests(unittest.TestCase):
    @patch("scripts.capture.subprocess.run")
    def test_reports_signal_and_empty_stderr_without_exposing_stream_url(
        self,
        run,
    ):
        run.return_value = subprocess.CompletedProcess([], -11, "", "")
        stderr = io.StringIO()

        with redirect_stderr(stderr), self.assertRaises(SystemExit):
            capture_frame("https://secret.example/stream.m3u8", "frame.jpg", 3, 30)

        output = stderr.getvalue()
        self.assertEqual(run.call_args.args[0][0], "ffmpeg")
        self.assertIn("terminated by signal 11", output)
        self.assertIn("(no stderr output)", output)
        self.assertNotIn("secret.example", output)

    @patch("scripts.capture.subprocess.run", side_effect=subprocess.TimeoutExpired("ffmpeg", 40))
    def test_reports_timeout_without_exposing_stream_url(self, _run):
        stderr = io.StringIO()

        with redirect_stderr(stderr), self.assertRaises(SystemExit):
            capture_frame("https://secret.example/stream.m3u8", "frame.jpg", 3, 30)

        output = stderr.getvalue()
        self.assertIn("timed out after 40 seconds", output)
        self.assertNotIn("secret.example", output)

    @patch("scripts.capture.subprocess.run", side_effect=FileNotFoundError)
    def test_reports_missing_ffmpeg(self, _run):
        stderr = io.StringIO()

        with redirect_stderr(stderr), self.assertRaises(SystemExit):
            capture_frame("https://secret.example/stream.m3u8", "frame.jpg", 3, 30)

        self.assertIn("not available on PATH", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
