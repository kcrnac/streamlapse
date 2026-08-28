"""
capture.py — Grab a single JPEG frame from the HLS stream and upload to Cloudflare R2.

Exits with code 1 on unrecoverable errors.

Required environment variables (set as GitHub Secrets):
  STREAM_URL       HLS stream URL (e.g. https://example.com/stream.m3u8)
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET_NAME
  R2_ENDPOINT      Full S3 endpoint URL (e.g. https://<account_id>.eu.r2.cloudflarestorage.com)
  CAPTURE_TIME_ZONE  IANA timezone used for R2 timestamps (e.g. Europe/Zagreb)
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


def load_config() -> dict:
    with CONFIG_PATH.open() as f:
        return yaml.safe_load(f)


def capture_frame(stream_url: str, output_path: str, quality: int, timeout: int) -> None:
    executable = "ffmpeg"
    cmd = [
        executable,
        "-y",
        "-loglevel", "error",
        "-timeout", str(timeout * 1_000_000),  # ffmpeg uses microseconds for timeout
        "-i", stream_url,
        "-frames:v", "1",
        "-q:v", str(quality),
        output_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    except FileNotFoundError:
        print("[ERROR] ffmpeg is not installed or not available on PATH", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(
            f"[ERROR] ffmpeg timed out after {timeout + 10} seconds "
            f"(executable: {executable})",
            file=sys.stderr,
        )
        sys.exit(1)

    if result.returncode != 0:
        if result.returncode < 0:
            status = f"terminated by signal {-result.returncode}"
        else:
            status = f"exited with code {result.returncode}"
        stderr = result.stderr.strip() or "(no stderr output)"
        print(
            f"[ERROR] ffmpeg {status} (executable: {executable}):\n{stderr}",
            file=sys.stderr,
        )
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
    size_bytes = os.path.getsize(local_path)
    print(f"[OK] Uploaded → {key} ({size_bytes} bytes)")


def main() -> None:
    cfg = load_config()

    required_env = [
        "STREAM_URL",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_ENDPOINT",
        "CAPTURE_TIME_ZONE",
    ]
    missing = [k for k in required_env if not os.environ.get(k)]
    if missing:
        print(f"[ERROR] Missing environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    timezone_name = os.environ["CAPTURE_TIME_ZONE"]
    tz = ZoneInfo(timezone_name)
    now = datetime.now(tz)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H-%M-%S")
    prefix = cfg["storage"]["r2_prefix"]
    r2_key = f"{prefix}/{date_str}/{time_str}.jpg"

    with tempfile.TemporaryDirectory() as tmpdir:
        frame_path = os.path.join(tmpdir, "frame.jpg")
        print(f"[INFO] Capturing frame at {now.strftime('%Y-%m-%d %H:%M:%S')} {timezone_name}")
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
