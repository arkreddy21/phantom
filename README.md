# PHANTOM — personal daily tracker

A theatrical personal habit and prompted-journal tracker. Daily records live on
the server in SQLite, not in browser storage. Original visuals and synthesized
reward sounds take inspiration from Persona 5; this project is not affiliated
with its publisher and does not ship extracted game assets.

## Run locally

Install a recent Node version supporting `node:sqlite` (Node 22.13+; the current
project is developed on Node 26) and pnpm.

```sh
pnpm install
export AUTH_USERNAME='your-username'
export AUTH_PASSWORD='your-long-random-password'
pnpm dev
```

The application login is required. The development server does not load `.env`
files automatically, so export both variables in your shell before starting it.
Choose a strong password and do not commit it.

Open the local URL printed by Vite (normally `http://localhost:5173`). The dev
API runs on port 3001. The database is created automatically in `data/`; it is
ignored by Git. Keep that directory when restarting or upgrading the app.

## Production

```sh
pnpm build
pnpm start
```

The server serves the built client and API together. Configure the writable data
directory and server settings using the variables in `.env.example` (set them in
your runtime environment). A persistent disk is required; ephemeral deployment
storage will lose data. This application is **not suitable for a static host**.

**Do not expose the server directly to the internet.** Configure the required
single-owner `AUTH_USERNAME` and `AUTH_PASSWORD`, and use HTTPS through a reverse
proxy for remote access. Origin validation prevents some browser cross-origin
writes; it is not a substitute for authentication.

## Daily use

- Create a check habit or a prompted journal, select a social stat, and set its
  point reward. Create custom social stats as needed.
- Complete check habits by day. Prompted journals count only after writing is
  submitted. Add optional reflections, sleep duration, or health notes.
- Browse previous dates and monthly activity history. Points reflect real
  completed records; editing writing does not award points again.
- Undo a completion to reverse its historical reward. Changing habit settings
  does not rewrite points already earned. Archive habits to preserve history.
- Use sound/reduced-motion controls when a quieter experience is preferable.
- Export a JSON backup from settings and keep it somewhere safe. Import replaces
  the current dataset, so export first. A browser is not your backup location.

Social stats currently accumulate points without rank thresholds or an upper
rank. Rank progression is intentionally deferred.

## Deployment

The deployment example targets an ARM64 Docker host, with GitHub Actions and
GHCR publishing an image and host-installed Caddy providing HTTPS. See the
[deployment guide](docs/deployment.md) for setup,
SSH secrets, DNS, persistent storage, and recovery instructions. Replace the
example hostname, image name, and host settings with values for your deployment.

## Development checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

See [architecture decisions](docs/adr/README.md) and the
[verification plan](docs/verification.md). Browser tests use isolated test data,
not the normal application database. All journal/health content is personal data:
protect both the database and exported backups.
