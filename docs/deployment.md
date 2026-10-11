# Deploy Phantom to an ARM64 Linux host

This guide describes a generic deployment using a shared Linux host, Docker
Compose, GitHub Actions, GHCR, and host-installed Caddy. The examples use
`phantom.example.com`, `ghcr.io/example/phantom`, and `/opt/phantom`; replace
these placeholders with your own hostname, GitHub owner/repository, and paths.

## What happens on a push

1. Pull requests and main-branch pushes run TypeScript, API, browser, and build checks.
2. Successful main runs build and publish a native `linux/arm64` image to GHCR.
3. The deployment job connects over verified SSH, installs the stack scripts,
   and selects the published **digest**, not `latest`.
4. The deploy script pulls before replacing the running service, backs up an
   existing healthy service, waits for health, and attempts to restart the prior
   image if the new image fails.
5. Caddy serves HTTPS and requires a password on **all** app and API routes.

The app container is non-root and has a read-only root filesystem. SQLite lives
in the persistent `phantom-data` volume. Its host port is loopback-only; no app
port needs opening in the host firewall.

## 1. Prepare the instance

Use an ARM64 Linux host with Docker and Docker Compose v2 (`up --wait`), plus
`bash`, `flock`, `curl`, and Python 3. Check:

```sh
uname -m                         # aarch64 expected
docker --version
docker compose version
command -v bash flock curl python3
```

Use a dedicated deployment account if possible. On Ubuntu, for example:

```sh
sudo adduser --disabled-password --gecos '' deploy-user
sudo usermod -aG docker deploy-user
sudo install -d -o deploy-user -g deploy-user -m 750 /opt/phantom
```

**Docker group membership is effectively root access.** This is a simple trusted
host setup, not a sandboxed deployment account. Do not use the key for other
services. Protect the GitHub repository and its production environment.

On your own machine, generate a dedicated key (never commit it):

```sh
ssh-keygen -t ed25519 -f ~/.ssh/deploy-user -C phantom-github-actions
```

For unattended Actions use, this dedicated key must be usable without an
interactive passphrase. Add its `.pub` contents to the deployment user's
`~/.ssh/authorized_keys`, prefixed with `restrict ` to disable forwarding and
PTY features. Ensure `.ssh` is mode 700, `authorized_keys` is 600, and ownership
belongs to the deployment account. Check SSH and Docker access before proceeding.

Configure the host firewall and any provider/network firewall for the SSH port.
GitHub-hosted runners do not have one fixed source IP; if SSH cannot be reached
under your existing rules, use a private-network deployment path instead. Do
not weaken SSH authentication or disable host verification.

## 2. Configure GitHub

Create a GitHub Actions environment named **production**. Add these secrets:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | Host's public IP address or SSH hostname, without scheme |
| `DEPLOY_USER` | Deployment account (for example, `deploy-user`) |
| `DEPLOY_SSH_KEY` | Full private key generated above, including header/footer |
| `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known_hosts entry for this host/port |

Set the environment variable `DEPLOY_PORT` if SSH is not on port 22.
Optional required reviewers let you approve each production deployment; omit
them if you want fully automatic deployment. Main-branch deployments are the
only ones allowed to use the production credentials.

Obtain the SSH host key through an already-trusted SSH connection or the host's
provider console. For example, on the instance:

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Compare that fingerprint with the key you collect from your machine using
`ssh-keyscan -t ed25519 -p 22 YOUR_HOST`. Store the matching scan line as
`DEPLOY_KNOWN_HOSTS`. For a nonstandard port it must use `[HOST]:PORT` syntax.
Do not accept a scan without independently checking its fingerprint. Changed
host keys should deliberately fail deployments until reverified.

The workflow publishes using GitHub's scoped `GITHUB_TOKEN`; **no GHCR PAT is
needed on the server for public images**. New GHCR packages can initially be
private even when the repository is public. After the first successful publish,
open the GitHub account's Packages page for the application package and set
visibility to **Public**. If the first deployment fails at anonymous pull,
make the package public and rerun the workflow. Do not put a personal PAT into
Compose merely to work around package visibility.

## 3. Configure the stack

From your local checkout, copy the initial configuration (replace `YOUR_HOST`
and add `-P YOUR_PORT` to scp for a nonstandard SSH port):

```sh
scp -i ~/.ssh/deploy-user deploy/compose.yaml deploy/deploy.sh deploy/backup.sh \
  deploy/.env.example deploy-user@YOUR_HOST:/opt/phantom/
ssh -i ~/.ssh/deploy-user deploy-user@YOUR_HOST
cd /opt/phantom
cp .env.example .env
chmod 600 .env
chmod 750 deploy.sh backup.sh
nano .env
```

The workflow updates the stack scripts and stages `compose.next.yaml`, preserving
the working Compose configuration, `.env`, and backups until health checks pass.
The example image value is a placeholder; don't try pulling it. The deploy script
replaces it with the real published digest on first deployment. Set the timezone
to your own calendar timezone; it controls future-date validation.

Set the public origin to `https://phantom.example.com`, the host port to 3100,
and the container port to 3001 unless you intentionally change the matching
Caddy settings. Leave private content out of source/images. The Compose image
reference is selected automatically by the deploy script; use a real immutable
digest or commit-SHA tag for manual first startup.

If you already have local entries, export a JSON backup in Phantom and import it
in the deployed app. Do not copy an actively running SQLite database file without
its WAL state. Export/import is the simplest consistent migration.

## Build and run locally with Docker

Docker can also build and run the application without Compose or a registry.
From the repository root, build for the architecture of the local Docker host:

```sh
docker build -t phantom:local .
```

On an x86-64 host, that normally creates an `amd64` image. To request that
platform explicitly, use `docker build --platform linux/amd64 -t phantom:local .`.
ARM64 image builds are part of CI; startup under emulation is not native ARM64
verification. An x86 host may also build ARM64 with Buildx and emulation if its
Docker setup supports it:

```sh
docker buildx build --platform linux/arm64 --load -t phantom:local .
```

Emulated startup is
useful for development, but is not a substitute for native ARM64 validation.

Run the image with local-only access, a persistent named volume, the non-root
container user from the image, and a writable data mount. Start from the example
environment file, set `PUBLIC_ORIGIN` to the local URL (the default shown here),
and set `TZ` to the desired calendar timezone:

```sh
cp deploy/.env.example .env
# Edit .env: set PUBLIC_ORIGIN=http://localhost:3100 and your preferred TZ.
docker volume create phantom-local-data
docker run -d --name phantom-local --restart unless-stopped \
  --read-only --init \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --mount source=phantom-local-data,target=/app/data \
  --publish 127.0.0.1:3100:3001 \
  --env-file .env \
  --env NODE_ENV=production --env HOST=0.0.0.0 --env PORT=3001 \
  --env DATA_DIR=/app/data phantom:local
```

Keep the host port bound to loopback unless access is protected by a suitable
network boundary. The named volume survives container replacement; do not
remove it unless its data is no longer needed. For an image archive supplied
separately, load it with `docker load -i IMAGE_ARCHIVE.tar.gz` and use the image
tag printed by Docker in place of `phantom:local` above.

## 4. DNS and Caddy

Add an **A** record for the chosen hostname pointing to the host's public IPv4.
Start with DNS-only if your DNS provider offers a proxy, for the simplest
certificate setup. Only add an AAAA record if IPv6 really reaches this server.

Ensure ports 80 and 443 reach Caddy through provider/network rules and the host
firewall. Generate a bcrypt password hash interactively on the instance:

```sh
caddy hash-password
```

Use a strong unique password. Do not paste the plaintext password into Git,
GitHub Actions, or command-line arguments. Use `deploy/Caddyfile.example` as a
reference snippet and adapt it into your existing Caddy configuration; replace
the hostname, username, and hash placeholders. The basic-auth block must protect
the entire hostname, not only the homepage. Use the **existing** Caddy
configuration rather than overwriting sites for other applications.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The example uses modern Caddy `basic_auth` (Caddy 2.8+); older installations used
`basicauth`. Upgrade or adapt to your installed version deliberately. If your DNS
provider's proxy is enabled, use strict end-to-end HTTPS. Do not add broad proxy
trust to Express; the configured public origin already handles the HTTPS/internal-
HTTP boundary.

## 5. First deployment and live checks

Push the deployment changes to `main`. Watch GitHub Actions: checks → image
publish → production deployment. Resolve package visibility as described above.
Creating files locally does not configure GitHub, DNS, or the host automatically.

On the server, inspect the stack and local health endpoint:

```sh
cd /opt/phantom
docker compose ps
docker compose logs --tail 100 phantom
curl --fail http://127.0.0.1:3100/api/health
```

Public access without credentials must fail with HTTP 401:

```sh
curl -I https://phantom.example.com/
curl -I https://phantom.example.com/api/state
```

Open the HTTPS site, enter your Caddy credentials, create a practice, complete
it, and reload. Verify a prompted journal saves too: that specifically checks the
HTTPS Origin path. A wrong-origin write must remain forbidden. Confirm entries
survive a container restart and test access to the other sites served by Caddy.

## Backups, rollbacks, and limits

Predeployment backups contain sensitive journals and health data. Keep server
backup files private and copy them off-host regularly; a volume and backups on
the same host do not protect against host loss. Periodically test a backup by
importing it into an isolated instance. The UI accepts validated versioned JSON,
not arbitrary database files.

Create a backup explicitly before risky configuration changes:

```sh
cd /opt/phantom
./backup.sh
```

To select a known prior image manually, use the exact previously recorded digest:

```sh
cd /opt/phantom
cp compose.yaml compose.next.yaml
./deploy.sh ghcr.io/example/phantom@sha256:REPLACE_WITH_64_HEX_DIGEST
```

This takes another backup and uses the same health checks. If the current service
is stopped/unhealthy, the script refuses an unsafe blind upgrade: inspect logs,
restore the last compatible image manually, or recover from a verified backup
before redeploying. Don't delete the volume to make a failing deployment pass.

Never run `docker compose down -v` or remove `phantom-data` unless you intend to
destroy the stored data. Don't prune unrelated images/volumes on a shared host.
Rollback changes the image only; it does **not** reverse a schema migration or
restore data automatically. Review migration compatibility before future upgrades.

This deployment intentionally has one replica and may briefly interrupt access
during upgrades. Caddy basic auth is sufficient temporary access protection,
not the future per-user application authorization system. An obscure domain is
not protection: DNS, scanning, and certificate transparency can reveal it.

## Verification boundary

See the [verification plan](verification.md) for automated evidence and remaining
gaps. Live SSH, DNS, Caddy credentials/certificates, and persistent storage
require the manual checks above; do not call the site deployed before those pass.
