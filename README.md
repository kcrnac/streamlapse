# streamlapse

**streamlapse** automatically captures a JPEG frame from any public HLS stream every 5 minutes (during configurable work hours), stores the frames in Cloudflare R2, and lets you assemble any date range into an MP4 timelapse on demand — all for free, with zero infrastructure to manage.

Everything runs on **GitHub Actions** (free on public repos) and **Cloudflare R2** (10 GB free tier, zero egress fees). No servers, no cron jobs, no cloud bills.

---

## How it works

```
HLS stream
    │
    ▼  every 5 min (GitHub Actions cron)
capture.py ──► ffmpeg grabs 1 JPEG frame
    │
    ▼
Cloudflare R2  screenshots/YYYY-MM-DD/HH-MM-SS.jpg
    │
    ▼  on demand (workflow_dispatch)
generate.py ──► downloads frames ──► ffmpeg assembles MP4
    │
    ▼
Cloudflare R2  videos/timelapse_<from>_to_<to>.mp4
    +  GitHub Actions artifact (direct download)
```

| Component                 | Role                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| **GitHub Actions**        | Free cron scheduler — runs `capture.py` every 5 minutes           |
| **Cloudflare R2**         | S3-compatible object storage — 10 GB free, zero egress fees       |
| **`scripts/capture.py`**  | Checks work hours → grabs JPEG frame via `ffmpeg` → uploads to R2 |
| **`scripts/generate.py`** | Downloads frames from R2 → assembles MP4 → uploads back to R2     |

Capture schedule: configurable in `config.yml` (default: Mon–Fri 07:00–17:00, every 5 minutes).

---

## Setup

### 1. Fork this repo and make it public

GitHub Actions on **public repos** have unlimited free minutes. The simplest path:

1. Click **Fork** on this repo
2. In the fork, go to **Settings → General** and make sure visibility is **Public**
3. Make your edits (configure `config.yml`, add secrets) and push to `main`

### 2. Create a Cloudflare R2 bucket

1. Log in to [Cloudflare dashboard](https://dash.cloudflare.com/) → **R2 Object Storage** → **Create bucket**
2. Choose a name (e.g. `my-streamlapse`) and pick your preferred region (EU, US, APAC)
3. Leave all other settings at their defaults and click **Create bucket**

> After creation you'll land on the bucket overview page. Note the **Account ID** displayed in the top-right corner — you'll need it to build the endpoint URL in step 3.

### 3. Create an R2 API token

1. From the R2 overview page, click **Manage R2 API Tokens** → **Create API Token**
2. Give it a name (e.g. `streamlapse`) and set:
   - **Permissions:** Object Read & Write
   - **Bucket:** restrict to the bucket you just created
   - **TTL:** no expiry (or set one if you prefer rotating credentials)
3. Click **Create API Token** — you'll see the credentials **once only**, so copy them now:
   - **Access Key ID** (starts with a long alphanumeric string)
   - **Secret Access Key**
4. On the same page, copy the **Jurisdiction-specific endpoint for S3 clients** — this is your `R2_ENDPOINT` value (looks like `https://<account_id>.eu.r2.cloudflarestorage.com`)

#### Endpoint by bucket region

| Bucket region | `R2_ENDPOINT` value                                  |
| ------------- | ---------------------------------------------------- |
| US (default)  | `https://<account_id>.r2.cloudflarestorage.com`      |
| EU            | `https://<account_id>.eu.r2.cloudflarestorage.com`   |
| APAC          | `https://<account_id>.apac.r2.cloudflarestorage.com` |

Replace `<account_id>` with the 32-character Cloudflare Account ID from the R2 overview page.

### 4. Add GitHub Secrets

In your forked repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret                 | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `STREAM_URL`           | Full HLS stream URL (e.g. `https://example.com/stream.m3u8`)    |
| `R2_ACCESS_KEY_ID`     | Access Key ID from your R2 API token                            |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key from your R2 API token                        |
| `R2_BUCKET_NAME`       | Your R2 bucket name (e.g. `my-streamlapse`)                     |
| `R2_ENDPOINT`          | Full S3 endpoint URL for your bucket's region (see table above) |

### 5. Configure the schedule

Edit [`config.yml`](config.yml) to match your stream's timezone and active hours:

```yaml
schedule:
  timezone: 'Europe/Zagreb' # any IANA timezone
  work_days: [Mon, Tue, Wed, Thu, Fri]
  work_hours:
    start: '07:00'
    end: '17:00'
```

Frames are captured only within these windows, so your R2 storage grows only when the stream is relevant.

### 6. Push and verify

After pushing your changes, go to **Actions → Capture Frame → Run workflow** and click **Run workflow**.  
If it's outside configured work hours the run exits with `[SKIP]` — that is expected. Pass `force: true` in the dispatch inputs to bypass the check.

---

## Generating a timelapse

### Via GitHub UI

1. Go to **Actions → Generate Timelapse → Run workflow**
2. Fill in the optional inputs:

| Input       | Default                        | Description                        |
| ----------- | ------------------------------ | ---------------------------------- |
| `date_from` | first day of current month     | Start date `YYYY-MM-DD`            |
| `date_to`   | today                          | End date `YYYY-MM-DD`              |
| `fps`       | `24`                           | Output video frame rate            |
| `output`    | auto-generated from date range | Output filename (e.g. `april.mp4`) |

3. When the run finishes, the MP4 is available as a downloadable **artifact** in the run summary, and also uploaded to R2 at `videos/`

### Via the GitHub REST API

```bash
curl -X POST \
  -H "Authorization: Bearer <YOUR_GITHUB_PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/actions/workflows/generate.yml/dispatches \
  -d '{
    "ref": "main",
    "inputs": {
      "date_from": "2026-04-01",
      "date_to":   "2026-04-30",
      "fps":        "24",
      "output":     "timelapse_april_2026.mp4"
    }
  }'
```

Generate a PAT at **GitHub → Settings → Developer settings → Personal access tokens (fine-grained)** with `Actions: write` permission on this repo.

---

## Configuration reference

All tuneable settings live in [`config.yml`](config.yml):

```yaml
schedule:
  timezone: 'Europe/Zagreb' # IANA timezone string
  work_days: [Mon, Tue, Wed, Thu, Fri]
  work_hours:
    start: '07:00'
    end: '17:00'

capture:
  interval_minutes: 5 # how often to capture (5, 10, 15, 30, or 60)
  jpeg_quality: 3 # ffmpeg -q:v: 1 (best) – 31 (worst); 2–4 is a good range
  ffmpeg_timeout: 30 # seconds to wait for the stream before giving up

storage:
  r2_prefix: 'screenshots' # R2 key prefix for captured frames
  videos_prefix: 'videos' # R2 key prefix for generated timelapse videos

generate:
  default_fps: 24 # output video frame rate
  video_scale: '1920:-2' # output width; height is auto-scaled to keep aspect ratio
```

---

## Local development

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Set required environment variables
export STREAM_URL=https://example.com/stream.m3u8
export R2_ACCESS_KEY_ID=your_access_key_id
export R2_SECRET_ACCESS_KEY=your_secret_access_key
export R2_BUCKET_NAME=my-streamlapse
export R2_ENDPOINT=https://<account_id>.eu.r2.cloudflarestorage.com

# Test capture (--force bypasses the work-hours check)
python scripts/capture.py --force

# Generate timelapse for a date range
python scripts/generate.py --date-from 2026-04-01 --date-to 2026-04-07 --fps 12
```

---

## GitHub Pages docs

This repo includes a documentation site in [`docs/`](docs/). To enable it:

1. Go to your repo **Settings → Pages**
2. Under **Build and deployment**, set Source to **Deploy from a branch**
3. Select branch **`main`** and folder **`/docs`**
4. Click **Save** — your docs will be live at `https://<your-username>.github.io/streamlapse`
