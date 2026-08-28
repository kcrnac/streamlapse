# streamlapse

**streamlapse** automatically captures a JPEG frame from any public HLS stream every 15 minutes (during configurable work hours), stores the frames in Cloudflare R2, and lets you assemble a date range into an MP4 timelapse on demand — with no servers to manage and free tiers that cover modest usage.

Scheduling runs on a **Cloudflare Worker Cron Trigger**, capture and video jobs run on **GitHub Actions**, and media is stored in **Cloudflare R2**. Public repositories can use standard GitHub-hosted runners without minute charges, and R2 includes a free allowance plus free Internet egress; usage above the applicable allowances can still be billed.

---

## How it works

```
Cloudflare Worker  ── every 15 min cron ──► reads schedule from config.yml
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
| **Cloudflare R2**                    | S3-compatible object storage with a free allowance and free egress     |
| **`scripts/capture.py`**             | Validates non-forced runs, grabs one JPEG with `ffmpeg`, uploads to R2 |
| **`scripts/generate.py`**            | Downloads frames from R2, assembles an MP4, uploads it back to R2      |

`config.yml` is the runtime source of truth for the capture timezone, work days,
and active window. Cloudflare is the only automatic scheduler. Its Cron Trigger
defines the fixed 15-minute cadence and an outer Monday-through-Saturday guard;
the Worker then applies `config.yml`. The effective schedule is therefore the
intersection of both controls. The current settings capture Monday through
Saturday from 06:30 through 18:00 in `Europe/Zagreb`; neither the Worker nor the
capture workflow runs automatically on Sunday.

---

## Setup

### 1. Fork this repo and make it public

Standard GitHub-hosted runners are free for **public repositories**, subject to
GitHub's current Actions usage policy. The simplest path:

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
    start: '06:30'
    end: '18:00'
```

The Cloudflare Worker reads this file directly from the configured GitHub ref
before every scheduling decision. The timezone and work-hour window are not
duplicated in Worker code. The 15-minute cadence and the outer Monday-through-
Saturday invocation guard live in `cloudflare/scheduler/wrangler.jsonc`; keep
that guard aligned if you intentionally change `schedule.work_days` to include
Sunday.

### 6. Deploy the Cloudflare scheduler

First update the non-secret repository target in
`cloudflare/scheduler/wrangler.jsonc`. Forks must replace the defaults with their
own owner and repository:

```jsonc
"vars": {
  "GITHUB_OWNER": "your-github-user",
  "GITHUB_REPO": "streamlapse",
  "GITHUB_REF": "main"
}
```

The Worker also needs a fine-grained GitHub personal access token restricted to
that repository with **Actions: Read and write** permission. Store this runtime
token once in Cloudflare, then perform the first deployment:

```bash
cd cloudflare/scheduler
corepack enable
pnpm install
pnpm wrangler login
pnpm wrangler secret put GITHUB_TOKEN
pnpm deploy
```

Future Worker changes are validated in pull requests and deployed automatically
after they reach `main` by the **Deploy Cloudflare Scheduler** workflow. Manual
deployments are also restricted to `main`. Create a GitHub environment named
`production` under **Settings → Environments**, restrict its deployment branch
to `main` (and add a required reviewer if desired), then add:

| Type                 | Name                    | Value                                                                    |
| -------------------- | ----------------------- | ------------------------------------------------------------------------ |
| Environment secret   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API token created from the **Edit Cloudflare Workers** template |
| Environment variable | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the Worker                           |

Restrict the Cloudflare token to the account that owns this Worker. It is a CI
deployment credential and is separate from the Worker's `GITHUB_TOKEN` runtime
secret. No R2 permission is needed to deploy this scheduler. Existing Worker
secrets that are not supplied by the deployment are preserved.

Cloudflare invokes the Worker at `00`, `15`, `30`, and `45` past every hour from
Monday through Saturday. The Worker reads the current schedule from `config.yml`
and calls the Capture Frame workflow only inside the configured window. It does
not run on Sunday. The GitHub workflow intentionally has no `schedule` trigger;
`workflow_dispatch` is its only entry point.

The separate Keepalive workflow remains scheduled twice monthly as a repository
activity safeguard. It does not trigger captures or affect the Cloudflare
scheduler.

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

Dates must use exact `YYYY-MM-DD` form and the start cannot be after the end.
FPS must be a positive integer. A supplied output must be a simple `.mp4`
basename containing only letters, numbers, dots, dashes, or underscores.

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

Capture and media settings live in [`config.yml`](config.yml). The fixed cron
cadence and GitHub repository target live in
[`cloudflare/scheduler/wrangler.jsonc`](cloudflare/scheduler/wrangler.jsonc):

```yaml
schedule:
  timezone: 'Europe/Zagreb' # IANA timezone string
  work_days: [Mon, Tue, Wed, Thu, Fri, Sat]
  work_hours:
    start: '06:30'
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
pip install --require-hashes -r requirements.txt

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

`requirements.in` lists direct Python dependencies; `requirements.txt` is the
hash-locked transitive install file generated from it. Dependency updates are
reviewed and applied manually; this repository does not run an automated
dependency-update bot.

The capture workflow caches a SHA-256-verified, immutable Linux FFmpeg build.
This is intentional: the smaller Linux executable bundled by
`imageio-ffmpeg==0.6.0` can crash while demuxing some HLS/MPEG-TS streams. On
Linux, run `.github/scripts/setup-ffmpeg-linux.sh` once before a local capture.
Windows local runs continue to use the verified bundled executable.

---

## GitHub Pages docs

This repo includes a documentation site in [`docs/`](docs/). To enable it:

1. Go to your repo **Settings → Pages**
2. Under **Build and deployment**, set Source to **Deploy from a branch**
3. Select branch **`main`** and folder **`/docs`**
4. Click **Save** — your docs will be live at `https://<your-username>.github.io/streamlapse`
