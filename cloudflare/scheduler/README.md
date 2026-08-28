# Streamlapse Cloudflare scheduler

This Worker is the external scheduler for `.github/workflows/capture.yml`.
Cloudflare evaluates the scheduled instant in `Europe/Zagreb` and dispatches the
workflow every 15 minutes, Monday through Saturday, from 06:00 through 18:00
inclusive.

The dispatch sends `force=true`. This is intentional: Cloudflare owns the new
schedule while the existing `capture.py` and `config.yml` behavior remains
unchanged.

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

The existing GitHub Actions cron should remain enabled until a Cloudflare Cron
event has successfully dispatched the workflow and produced a new R2 image.
After that proof, remove only the `schedule` block from `capture.yml` and retain
`workflow_dispatch`.
