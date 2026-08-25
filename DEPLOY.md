# Deploying the portal

The app is a long-running Node server, not a serverless function: a build takes
10–15 minutes and job state lives in memory. That means it needs **one
always-alive instance**. Anything that autoscales to multiple replicas will lose
in-flight builds.

`output: 'standalone'` plus the `Dockerfile` make it portable — the same image
runs on Render, Kinsta Application Hosting, Railway, or a plain VM.

## Render (free tier)

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → select the repo. It reads
   `render.yaml`.
3. Fill in the env vars below. `PORTAL_SECRET` is generated for you.
4. Deploy. First build takes a few minutes.

### Free-tier behaviour

Free instances spin down after ~15 minutes with no inbound requests, and cold
starts take roughly a minute. Two things make that safe here:

- While a client watches the progress stream, its open connection counts as
  activity.
- While any job is running, the server pings its own `/api/health` every 10
  minutes (see `src/lib/jobs.ts`), so a build survives even if the user closes
  the tab. This is scoped to active jobs, so the app still sleeps when idle and
  stays well inside the 750 free instance-hours/month — a 15-minute build costs
  0.25 of them.

Render injects `RENDER_EXTERNAL_URL`, which the keep-alive uses automatically.
On any other host, set `APP_URL` to the public URL instead.

### Known limit

An instance restart (deploy, platform maintenance) kills in-flight jobs, because
job state is in memory. This is not Render-specific — it applies equally on
Railway and Kinsta. Surviving restarts would require persisting jobs to a
database; that is deliberately not built, since a lost build is recoverable by
deleting the partial app and re-running.

## Environment variables

Set these in the host's dashboard. Never commit them.

### Portal auth
| Key | Notes |
|---|---|
| `PORTAL_PASSWORD` | What you type on the login page |
| `PORTAL_SECRET` | Session cookie value. Rotate to sign everyone out |

### Cloudways API
| Key | Notes |
|---|---|
| `CLOUDWAYS_EMAIL` | Account email |
| `CLOUDWAYS_API_KEY` | From Cloudways → API Keys |
| `CLOUDWAYS_SERVER_ID` | Server hosting the templates |
| `CLOUDWAYS_TEMPLATE_APP_ID` | Fallback template app |

### Template WordPress site
| Key | Notes |
|---|---|
| `TEMPLATE_WP_URL` | e.g. `https://abc.cloudwaysapps.com` |
| `TEMPLATE_WP_USERNAME` | WP user |
| `TEMPLATE_WP_APP_PASSWORD` | Application password, **not** the login password |
| `TEMPLATE_WP_PATH` | WP path on disk |

### SMTP (optional — summary emails are skipped if unset)
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

### SSH (optional — only used by `/api/test` diagnostics)
`SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PRIVATE_KEY`

Paste the key into `SSH_PRIVATE_KEY`. `SSH_KEY_PATH` does not work on container
hosts — the filesystem is ephemeral.

## Other hosts

**Kinsta Application Hosting / Railway** — point at the repo, use the
`Dockerfile`, set the same env vars, set `APP_URL` to the public URL. Neither
sleeps, so the keep-alive is harmless but unnecessary.

**Plain VM (e.g. Oracle Always Free)** — `docker build -t portal . && docker run
-d --restart unless-stopped -p 3000:3000 --env-file .env portal`, with a
reverse proxy in front for TLS.

## Local checks

```bash
npm run build      # production build, includes typecheck
npx eslint src/    # lint
curl localhost:3000/api/health
```
