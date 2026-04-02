"""
capture.py — Grab a single JPEG frame from the HLS stream and upload to Cloudflare R2.

Exits with code 0 (no-op) when called outside configured work hours/days.
Exits with code 1 on unrecoverable errors.

Required environment variables (set as GitHub Secrets):
  STREAM_URL       HLS stream URL (e.g. https://example.com/stream.m3u8)
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET_NAME
  R2_ENDPOINT      Full S3 endpoint URL (e.g. https://<account_id>.eu.r2.cloudflarestorage.com)
"""

import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import boto3
import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config.yml"

DAY_MAP = {
    "Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3,
    "Fri": 4, "Sat": 5, "Sun": 6,
}


def load_config() -> dict:
    with CONFIG_PATH.open() as f:
        return yaml.safe_load(f)


def is_work_time(cfg: dict) -> bool:
    tz = ZoneInfo(cfg["schedule"]["timezone"])
    now = datetime.now(tz)
    weekday = now.weekday()

    work_days = {DAY_MAP[d] for d in cfg["schedule"]["work_days"]}
    if weekday not in work_days:
        return False

    start_h, start_m = map(int, cfg["schedule"]["work_hours"]["start"].split(":"))
    end_h, end_m = map(int, cfg["schedule"]["work_hours"]["end"].split(":"))
    start = now.replace(hour=start_h, minute=start_m, second=0, microsecond=0)
    end = now.replace(hour=end_h, minute=end_m, second=0, microsecond=0)

    return start <= now <= end


def capture_frame(stream_url: str, output_path: str, quality: int, timeout: int) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel", "error",
        "-timeout", str(timeout * 1_000_000),  # ffmpeg uses microseconds for timeout
        "-i", stream_url,
        "-frames:v", "1",
        "-q:v", str(quality),
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    if result.returncode != 0:
        print(f"[ERROR] ffmpeg failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)


def upload_to_r2(local_path: str, bucket: str, key: str,
                 access_key: str, secret_key: str) -> None:
    raw = os.environ["R2_ENDPOINT"].strip()
    if not raw.startswith("http"):
        raw = f"https://{raw}"
    endpoint = raw
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    client.upload_file(
        local_path,
        bucket,
        key,
        ExtraArgs={"ContentType": "image/jpeg"},
    )
    print(f"[OK] Uploaded → {key}")


def main() -> None:
    force = "--force" in sys.argv or os.environ.get("CAPTURE_FORCE") == "true"

    cfg = load_config()

    if not force and not is_work_time(cfg):
        tz = ZoneInfo(cfg["schedule"]["timezone"])
        now = datetime.now(tz)
        print(f"[SKIP] Outside work hours: {now.strftime('%A %Y-%m-%d %H:%M')} {cfg['schedule']['timezone']}")
        sys.exit(0)

    if not force:
        interval = cfg["capture"].get("interval_minutes", 5)
        tz = ZoneInfo(cfg["schedule"]["timezone"])
        now = datetime.now(tz)
        if now.minute % interval != 0:
            print(f"[SKIP] Not on capture interval ({interval} min, current minute: {now.minute})")
            sys.exit(0)

    if force:
        print("[INFO] --force flag set, bypassing work-hours and interval checks.")

    required_env = ["STREAM_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT"]
    missing = [k for k in required_env if not os.environ.get(k)]
    if missing:
        print(f"[ERROR] Missing environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    tz = ZoneInfo(cfg["schedule"]["timezone"])
    now = datetime.now(tz)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H-%M-%S")
    prefix = cfg["storage"]["r2_prefix"]
    r2_key = f"{prefix}/{date_str}/{time_str}.jpg"

    with tempfile.TemporaryDirectory() as tmpdir:
        frame_path = os.path.join(tmpdir, "frame.jpg")
        print(f"[INFO] Capturing frame at {now.strftime('%Y-%m-%d %H:%M:%S')} {cfg['schedule']['timezone']}")
        capture_frame(
            stream_url=os.environ["STREAM_URL"],
            output_path=frame_path,
            quality=cfg["capture"]["jpeg_quality"],
            timeout=cfg["capture"]["ffmpeg_timeout"],
        )

        upload_to_r2(
            local_path=frame_path,
            bucket=os.environ["R2_BUCKET_NAME"],
            key=r2_key,
            access_key=os.environ["R2_ACCESS_KEY_ID"],
            secret_key=os.environ["R2_SECRET_ACCESS_KEY"],
        )


if __name__ == "__main__":
    main()
