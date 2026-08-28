import argparse
import unittest
from datetime import date

from scripts.generate import output_basename, parse_date, positive_fps


class GenerateInputValidationTests(unittest.TestCase):
    def test_accepts_expected_inputs(self):
        self.assertEqual(parse_date("2026-08-28"), date(2026, 8, 28))
        self.assertEqual(positive_fps("24"), 24)
        self.assertEqual(output_basename("timelapse_august-2026.mp4"), "timelapse_august-2026.mp4")

    def test_rejects_non_iso_dates(self):
        for value in ("20260828", "28-08-2026", "2026-02-30", "2026-01-01; id"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                parse_date(value)

    def test_rejects_non_positive_or_injected_fps(self):
        for value in ("0", "-1", "$(id)", '24\"; id'):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                positive_fps(value)

    def test_rejects_paths_and_unsafe_output_names(self):
        for value in (
            "../timelapse.mp4",
            "folder/timelapse.mp4",
            "folder\\timelapse.mp4",
            "/tmp/timelapse.mp4",
            "timelapse.mov",
            "timelapse.mp4; id",
        ):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                output_basename(value)


if __name__ == "__main__":
    unittest.main()
