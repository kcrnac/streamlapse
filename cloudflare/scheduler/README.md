# Streamlapse Cloudflare scheduler

This Worker is the only automatic scheduler for
`.github/workflows/capture.yml`. Cloudflare invokes it at `00`, `15`, `30`, and
`45` past each hour from 04:00 through 17:45 UTC, Monday through Saturday. It
is not invoked on Sunday.

All automatic schedule configuration lives in `wrangler.jsonc`:

```jsonc
"vars": {
  "SCHEDULE_TIME_ZONE": "Europe/Zagreb",
  "SCHEDULE_START": "06:30",
  "SCHEDULE_END": "18:00"
},
"triggers": {
  "crons": ["*/15 4-17 * * MON-SAT"]
}
```

Cloudflare Cron Triggers use UTC. The Cron expression limits invocations to the
UTC hours that cover the configured Zagreb window in both CET and CEST. The
Worker then checks the exact local-time boundary. This keeps the 06:30–18:00
Zagreb schedule correct across daylight-saving changes without invoking the
Worker overnight. The Worker does not download or parse `config.yml`.

Inside the window, the Worker calls GitHub's workflow-dispatch API once and
passes `SCHEDULE_TIME_ZONE` to the capture workflow for the R2 timestamp. A
manual workflow run always captures and may override that timezone input.

## Local validation

```sh
pnpm install
pnpm typecheck
pnpm test
```

## Secret and deployment

Set the non-secret target and schedule in `wrangler.jsonc` before deploying a
fork:

```jsonc
"vars": {
  "GITHUB_OWNER": "your-github-user",
  "GITHUB_REPO": "streamlapse",
  "GITHUB_REF": "main",
  "SCHEDULE_TIME_ZONE": "Europe/Zagreb",
  "SCHEDULE_START": "06:30",
  "SCHEDULE_END": "18:00"
}
```

Create a fine-grained GitHub personal access token restricted to the configured
repository with **Actions: Read and write** permission. Store it in Cloudflare;
never add it to a file:

```sh
pnpm wrangler secret put GITHUB_TOKEN
pnpm deploy
```

Pull requests that change this directory run type-checks and tests. Once merged
to `main`, `.github/workflows/deploy-cloudflare-scheduler.yml` deploys the Worker
through the GitHub `production` environment. Manual deployment is also limited
to `main`. That environment contains the `CLOUDFLARE_API_TOKEN` secret and
`CLOUDFLARE_ACCOUNT_ID` variable; neither is a Worker runtime binding. The
existing `GITHUB_TOKEN` Worker secret is preserved across code-only deployments.

Workers Logs are enabled for every invocation and traces are sampled at one
percent. Logs are emitted as structured JSON without credentials.

GitHub Actions has no capture cron. Keep `workflow_dispatch` in `capture.yml`:
it is the API entry point used by this Worker and by manual runs.
