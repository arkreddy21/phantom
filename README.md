# PHANTOM — personal daily tracker

A theatrical personal habit and prompted-journal tracker. Daily records live on
the server in SQLite, not in browser storage. Original visuals and synthesized
reward sounds take inspiration from Persona 5; this project is not affiliated
with its publisher and does not ship extracted game assets.

## Run locally

Install a recent Node version supporting `node:sqlite` (Node 22.13+; the current
project is developed on Node 26) and pnpm.

```sh
cp .env.example .env
# Edit .env and replace AUTH_USERNAME and AUTH_PASSWORD with strong values.
pnpm install
pnpm dev
```

The application loads `.env` for `pnpm dev`; shell variables you already
exported take precedence. The application login is required. Choose a strong
password and do not commit `.env`.

Open the local URL printed by Vite (normally `http://localhost:5173`). The dev
API runs on port 3001. The database is created automatically in `data/`; it is
ignored by Git. Keep that directory when restarting or upgrading the app.

## Production

### Docker Compose (recommended for self-hosting)

For a Linux server, start with the [Docker deployment guide](docs/deployment.md).
It includes a complete Compose file and `.env` example, plus commands to pull
and start the published image. The CI-published image is currently **ARM64
only**. An x86-64 server must build the image locally; do not expect the
published image to run on it.

Docker keeps the application and its runtime together. The database must live
in a persistent Docker volume so it survives container replacement. Do not
expose the application directly to the internet: use the required application
login and, for remote access, HTTPS through a reverse proxy.

### Run from source

Use this option when developing or when you prefer to build and run the Node.js
application directly. Install Node 22.13+ (Node 26 is used for development) and
pnpm, then create a private environment file and edit the credentials:

```sh
cp .env.example .env
# Edit .env and replace AUTH_USERNAME and AUTH_PASSWORD with strong values.
pnpm install
pnpm build
pnpm start
```

The server serves the built client and API together on port 3001. The application
loads `.env` for `pnpm dev` and `pnpm start`; shell variables you already exported
take precedence. Keep `.env` private and do not commit it. The database defaults
to `data/`; keep that directory and back it up. A persistent disk is required:
ephemeral deployment storage will lose data. This application is **not suitable
for a static host**.

For remote access, put an HTTPS reverse proxy in front of the app and configure
`PUBLIC_ORIGIN` to the exact HTTPS origin. Set `AUTH_TRUST_PROXY=1` only when the
app is reachable exclusively through one trusted proxy hop. Origin validation
prevents some browser cross-origin writes; it is not a substitute for
authentication.

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

## Self-hosting

See the [deployment guide](docs/deployment.md) for generic Docker Compose and
HTTPS reverse-proxy instructions. It does not require GitHub-to-server SSH
deployment; updates can be pulled and started manually.

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
