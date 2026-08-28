# Streamlapse Cloudflare scheduler

This Worker is the external scheduler for `.github/workflows/capture.yml`.
Cloudflare invokes it every 15 minutes (`00`, `15`, `30`, and `45` past each
hour), Monday through Saturday. It is not invoked on Sunday. On every
invocation, the Worker reads the `schedule` section of the root `config.yml`
from `main`, evaluates the scheduled instant in the configured timezone, and
dispatches the capture workflow only when the configured day and time window
are eligible.

The dispatch sends `force=true` because Cloudflare has already evaluated the
shared configuration. Manual workflow runs can leave `force=false` to apply the
same day and work-hours checks inside `capture.py`.

## Local validation

```sh
pnpm install
pnpm types
pnpm typecheck
pnpm test
```

## Secret and deployment

Create a fine-grained GitHub personal access token restricted to
`kcrnac/streamlapse` with repository permission **Actions: Read and write**.
Store it in Cloudflare; never add it to a file:

```sh
pnpm wrangler secret put GITHUB_TOKEN
pnpm deploy
```

Pull requests that change this directory run type-checks and tests. Once merged
to `main`, `.github/workflows/deploy-cloudflare-scheduler.yml` deploys the Worker
through the GitHub `production` environment. That environment contains the
`CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable; neither is a
Worker runtime binding. The existing `GITHUB_TOKEN` Worker secret is preserved
across code-only deployments.

GitHub Actions does not have its own capture cron. Keep `workflow_dispatch` in
`capture.yml`: it is the API entry point used by this Worker and by manual runs.
