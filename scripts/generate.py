"""
generate.py — Download frames from Cloudflare R2 and assemble an MP4 timelapse.

Usage (called by GitHub Actions workflow_dispatch):
  python scripts/generate.py \
      --date-from 2026-04-01 \
      --date-to   2026-04-30 \
      --fps       24 \
      --output    timelapse_april.mp4

Required environment variables (set as GitHub Secrets):
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY
  R2_BUCKET_NAME
  R2_ENDPOINT      Full S3 endpoint URL (e.g. https://<account_id>.eu.r2.cloudflarestorage.com)
"""

import argparse
import os
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import boto3
import yaml


CONFIG_PATH = Path(__file__).parent.parent / "config.yml"


def load_config() -> dict:
    with CONFIG_PATH.open() as f:
        return yaml.safe_load(f)


def get_r2_client(access_key: str, secret_key: str):
    raw = os.environ["R2_ENDPOINT"].strip()
    if not raw.startswith("http"):
        raw = f"https://{raw}"
    endpoint = raw
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def list_frames(client, bucket: str, prefix: str, date_from: date, date_to: date) -> list[str]:
    """Return sorted list of R2 keys within the specified date range."""
    keys = []
    paginator = client.get_paginator("list_objects_v2")
    current = date_from
    while current <= date_to:
        day_prefix = f"{prefix}/{current.strftime('%Y-%m-%d')}/"
        pages = paginator.paginate(Bucket=bucket, Prefix=day_prefix)
        for page in pages:
            for obj in page.get("Contents", []):
                if obj["Key"].lower().endswith(".jpg"):
                    keys.append(obj["Key"])
        current += timedelta(days=1)

    keys.sort()
    return keys


def download_frames(client, bucket: str, keys: list[str], dest_dir: str) -> list[str]:
    local_paths = []
    for i, key in enumerate(keys):
        filename = f"frame_{i:06d}.jpg"
        local_path = os.path.join(dest_dir, filename)
        client.download_file(bucket, key, local_path)
        local_paths.append(local_path)
        if (i + 1) % 50 == 0:
            print(f"[INFO] Downloaded {i + 1}/{len(keys)} frames…")
    print(f"[INFO] Downloaded all {len(keys)} frames.")
    return local_paths


def build_timelapse(frames_dir: str, output_path: str, fps: int, scale: str) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel", "error",
        "-framerate", str(fps),
        "-pattern_type", "glob",
        "-i", os.path.join(frames_dir, "frame_*.jpg"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-vf", f"scale={scale}",
        "-movflags", "+faststart",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ERROR] ffmpeg failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"[OK] Video assembled → {output_path}")


def upload_video(client, bucket: str, local_path: str, key: str) -> str:
    client.upload_file(
        local_path,
        bucket,
        key,
        ExtraArgs={"ContentType": "video/mp4"},
    )
    print(f"[OK] Uploaded → {key}")
    return key


def main() -> None:
    parser = argparse.ArgumentParser(description="Assemble HLS stream timelapse MP4")
    parser.add_argument("--date-from", required=False, default=None,
                        help="Start date YYYY-MM-DD (default: earliest available)")
    parser.add_argument("--date-to", required=False, default=None,
                        help="End date YYYY-MM-DD (default: today)")
    parser.add_argument("--fps", type=int, default=None,
                        help="Frames per second (default: from config.yml)")
    parser.add_argument("--output", default=None,
                        help="Output filename (without path, uploaded to R2 videos/ prefix)")
    args = parser.parse_args()

    cfg = load_config()

    required_env = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT"]
    missing = [k for k in required_env if not os.environ.get(k)]
    if missing:
        print(f"[ERROR] Missing environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    fps = args.fps or cfg["generate"]["default_fps"]
    scale = cfg["generate"]["video_scale"]
    prefix = cfg["storage"]["r2_prefix"]
    videos_prefix = cfg["storage"]["videos_prefix"]
    bucket = os.environ["R2_BUCKET_NAME"]

    today = date.today()
    date_to = date.fromisoformat(args.date_to) if args.date_to else today
    date_from = date.fromisoformat(args.date_from) if args.date_from else date(today.year, today.month, 1)

    output_name = args.output or f"timelapse_{date_from.isoformat()}_to_{date_to.isoformat()}.mp4"
    r2_video_key = f"{videos_prefix}/{output_name}"

    client = get_r2_client(
        access_key=os.environ["R2_ACCESS_KEY_ID"],
        secret_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )

    print(f"[INFO] Listing frames from {date_from} to {date_to}…")
    keys = list_frames(client, bucket, prefix, date_from, date_to)
    if not keys:
        print(f"[ERROR] No frames found in R2 for the range {date_from} – {date_to}.", file=sys.stderr)
        sys.exit(1)
    print(f"[INFO] Found {len(keys)} frames.")

    # Write final MP4 to CWD so GitHub Actions artifact upload can find it.
    video_path = os.path.join(os.getcwd(), output_name)

    with tempfile.TemporaryDirectory() as tmpdir:
        download_frames(client, bucket, keys, tmpdir)
        print(f"[INFO] Building timelapse at {fps} fps, scale={scale}…")
        build_timelapse(tmpdir, video_path, fps, scale)

    upload_video(client, bucket, video_path, r2_video_key)
    print(f"[INFO] Local file kept at: {video_path}")


if __name__ == "__main__":
    main()
