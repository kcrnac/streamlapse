# streamlapse

**streamlapse** automatically captures a JPEG frame from any public HLS stream every 15 minutes (during configurable work hours), stores the frames in Cloudflare R2, and lets you assemble any date range into an MP4 timelapse on demand — all for free, with zero infrastructure to manage.

Scheduling runs on a **Cloudflare Worker Cron Trigger**, capture and video jobs run on **GitHub Actions** (free on public repos), and media is stored in **Cloudflare R2** (10 GB free tier, zero egress fees). There are no servers to manage.

---

## How it works

```
Cloudflare Worker  ── every 5 min heartbeat ──► reads schedule from config.yml
    │
    ▼  eligible times only (workflow_dispatch)
GitHub Actions ──► capture.py ──► ffmpeg grabs 1 JPEG frame from the HLS stream
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

| Component                            | Role                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- |
| **Cloudflare Worker Cron Trigger**   | Reads `config.yml` and dispatches eligible captures                   |
| **GitHub Actions**                   | Runs capture and on-demand timelapse jobs                             |
| **Cloudflare R2**                    | S3-compatible object storage — 10 GB free, zero egress fees           |
| **`scripts/capture.py`**             | Validates non-forced runs, grabs one JPEG with `ffmpeg`, uploads to R2 |
| **`scripts/generate.py`**            | Downloads frames from R2, assembles an MP4, uploads it back to R2      |

`config.yml` is the single source of truth for the capture timezone, work days,
and active window. Cloudflare is the only automatic scheduler and invokes the
Worker every 15 minutes. The current schedule is Monday through Saturday from
06:00 through 18:00 in `Europe/Zagreb`; Sunday is disabled.

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
  work_days: [Mon, Tue, Wed, Thu, Fri, Sat]
  work_hours:
    start: '06:00'
    end: '18:00'
```

The Cloudflare Worker reads this file directly from `main` before every
scheduling decision, so the timezone, days, and work hours are not duplicated
in Worker code. The 15-minute cadence is defined once by the Cloudflare Cron
Trigger in `cloudflare/scheduler/wrangler.jsonc`.

### 6. Deploy the Cloudflare scheduler

Create a fine-grained GitHub personal access token restricted to this repository with **Actions: Read and write** permission. Then deploy the Worker and enter the token when prompted:

```bash
cd cloudflare/scheduler
corepack enable
pnpm install
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN
pnpm deploy
```

Cloudflare invokes the Worker at `00`, `15`, `30`, and `45` past every hour from
Monday through Saturday. The Worker reads the current schedule from `config.yml`
and calls the Capture Frame workflow only inside the configured window. It does
not run on Sunday. The GitHub workflow intentionally has no `schedule` trigger;
`workflow_dispatch` is its only entry point.

### 7. Push and verify

After pushing your changes, go to **Actions → Capture Frame → Run workflow** and click **Run workflow**. If it is outside the configured schedule, a normal manual run exits with `[SKIP]`. Pass `force: true` to bypass the schedule for testing. Automatic Cloudflare dispatches use `force: true` only after the Worker has evaluated `config.yml`.

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
  work_days: [Mon, Tue, Wed, Thu, Fri, Sat]
  work_hours:
    start: '06:00'
    end: '18:00'

capture:
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

# Validate the Cloudflare scheduler
cd cloudflare/scheduler
pnpm install
pnpm typecheck
pnpm test
```

---

## GitHub Pages docs

This repo includes a documentation site in [`docs/`](docs/). To enable it:

1. Go to your repo **Settings → Pages**
2. Under **Build and deployment**, set Source to **Deploy from a branch**
3. Select branch **`main`** and folder **`/docs`**
4. Click **Save** — your docs will be live at `https://<your-username>.github.io/streamlapse`
