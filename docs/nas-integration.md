# NAS Integration: SFTP & GitHub Actions Dispatch

## 1. Ugreen NAS SFTP — What's Already Supported

UGOS Pro runs Debian 12 under the hood. When you enable SSH (Control Panel → Terminal → SSH toggle), `sshd` starts and **SFTP is automatically available on the same port** — no separate configuration needed. You can use `sftp`, FileZilla, WinSCP, or `paramiko` in Python to connect.

### Public / External Access Options

| Method | Status | Notes |
|--------|--------|-------|
| Port forward TCP 22 (or custom) on router | ✅ Works | Needs router config; harden with key-only auth + non-standard port |
| Ugreen Link (official relay) | ❌ Not for SFTP | Web/SMB file browser only, not raw SFTP |
| Tailscale on NAS | ✅ Recommended | Zero port exposure; NAS gets a stable VPN IP usable from GitHub runners via `tailscale` action |
| Cloudflare Tunnel (`cloudflared`) | ✅ Works | TCP tunneling mode; no router config |

If the NAS is already publicly accessible via SFTP via port forwarding, Phase 1 of the migration plan is already done.

---

## 2. Triggering GitHub Actions from the NAS

Two useful use cases:

- **Use case A:** Trigger `generate.py` (timelapse assembly) from NAS instead of going to the GitHub UI.
- **Use case B:** Trigger `sync.yml` immediately after a batch of screenshots arrive, rather than waiting for the 6-hour sync cron.

### Required: Fine-Grained GitHub PAT

1. Go to GitHub → Settings → Developer settings → Fine-grained tokens
2. Repository: `kcrnac/streamlapse`
3. Permission: **Actions → Read and write** (allows `workflow_dispatch`)
4. Store on NAS at `/opt/streamlapse/.gh-token`, mode `600`

```sh
chmod 600 /opt/streamlapse/.gh-token
```

---

## 3. Trigger Scripts (deploy to NAS)

### `/opt/streamlapse/trigger-sync.sh`

```sh
#!/bin/sh
GITHUB_TOKEN="$(cat /opt/streamlapse/.gh-token)"
OWNER="kcrnac"
REPO="streamlapse"

curl -s -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/actions/workflows/sync.yml/dispatches \
  -d '{"ref":"main"}'
```

### `/opt/streamlapse/trigger-generate.sh`

```sh
#!/bin/sh
GITHUB_TOKEN="$(cat /opt/streamlapse/.gh-token)"
OWNER="kcrnac"
REPO="streamlapse"
DATE_FROM="$(date -d 'last month' +%Y-%m-01)"
DATE_TO="$(date +%Y-%m-01)"

curl -s -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/actions/workflows/generate.yml/dispatches \
  -d "{\"ref\":\"main\",\"inputs\":{\"date_from\":\"$DATE_FROM\",\"date_to\":\"$DATE_TO\",\"fps\":\"24\"}}"
```

Make both scripts executable:

```sh
chmod +x /opt/streamlapse/trigger-sync.sh /opt/streamlapse/trigger-generate.sh
```

---

## 4. NAS Cron Jobs

Add via UGOS Task Scheduler or `crontab -e` over SSH:

| Job | Schedule | Command |
|-----|----------|---------|
| Trigger sync workflow | `0 */6 * * *` | `/opt/streamlapse/trigger-sync.sh` |
| Trigger generate (monthly) | `0 8 1 * *` | `/opt/streamlapse/trigger-generate.sh` |

### (Optional) Real-Time Sync on New Screenshot

Install `inotify-tools` (`apt install inotify-tools` on UGOS Pro), then run as a background service:

```sh
#!/bin/sh
# Watches for new screenshots, triggers sync after 60s quiet period
inotifywait -m -r -e close_write /volume1/streamlapse/screenshots/ \
  | while read path action file; do
      sleep 60
      /opt/streamlapse/trigger-sync.sh
    done
```

---

## 5. Updated Architecture

```
GitHub Actions cron (every 15 min, Mon-Sat 07:00-17:00 Europe/Zagreb)
  → capture.py → upload screenshot to NAS via SFTP

NAS (inotifywait or cron every 6h)
  → POST → GitHub API → triggers sync.yml
      → sync.py: NAS → R2 archived/, moves live R2 → archived/

NAS (cron 1st of month, 08:00)
  → POST → GitHub API → triggers generate.yml
      → generate.py: reads NAS frames → assembles MP4 → stores on NAS + R2
```

---

## 6. NAS Setup Checklist

- [ ] Enable SSH on UGOS Pro (Control Panel → Terminal)
- [ ] Verify SFTP works: `sftp -P <port> <user>@<your-nas-host>`
- [ ] Create `/opt/streamlapse/` directory on NAS
- [ ] Create fine-grained GitHub PAT with `Actions: Read and write`
- [ ] Store PAT in `/opt/streamlapse/.gh-token` (`chmod 600`)
- [ ] Deploy `trigger-sync.sh` and `trigger-generate.sh` (`chmod +x`)
- [ ] Add cron entries via UGOS Task Scheduler or `crontab -e`
- [ ] (Optional) Set up `inotifywait` service for real-time sync triggering

---

## 7. Notes

- No workflow YAML changes are needed — both `sync.yml` and `generate.yml` already have `workflow_dispatch` triggers.
- The PAT lives only on the NAS and is never stored in the GitHub repository.
- If you later adopt Tailscale, the GitHub Actions runner can reach the NAS directly without any open ports — set up the `tailscale/github-action` step in the workflow instead of port forwarding.
