# Deploy Phantom: beginner's guide

This guide deploys Phantom to an ARM64 Linux server and puts Caddy in front of
it for HTTPS and password protection. The examples use `phantom.example.com`,
`ghcr.io/example/phantom`, and a `~/phantom` folder. Replace these placeholders
with your own values.

## First, understand the three places involved

- **Your laptop** is where you edit the project and push changes to GitHub.
- **GitHub** stores the source code, runs the automated build, and stores the
  finished container image in GitHub Container Registry (GHCR).
- **Your server** downloads that image and runs it as a container. It keeps
  Phantom's database in a Docker volume on the server.

The source code is not the running application. A **container image** is the
packaged application; a **container** is one running copy of that image. The
`phantom-data` volume is where the database lives, separately from both. Replacing
the container does not delete that volume. Never remove the volume unless you
intend to erase the database.

There are two ways to update the server:

1. **Recommended first setup: manual update.** GitHub builds and publishes the
   image; you tell the server to download and run it with a few commands.
2. **Optional later: automatic deployment.** A workflow can connect from GitHub
   to your server using SSH and replace the image for you. It requires extra
   setup; skip that until the manual path is working.

The image tag `:latest` is a movable label that points to the newest image. It
does **not** make an already-running container update itself. To install an
updated image, run `docker compose pull` and then `docker compose up -d --wait`
on the server.

## Part 1 — Build and publish the image

### LAPTOP — save and push your project changes

Make sure the intended workflow changes are committed and pushed to the
repository's `main` branch. Stage only the files you intend to publish; do not
stage secrets or private notes. No Docker build on your laptop or source-code
checkout on the server is needed for this deployment path.

```sh
git status
git add PATH_TO_INTENDED_FILES
git commit -m "Prepare Phantom deployment"
git push origin main
```

If your changes are already committed, skip `git add` and `git commit`.

### GITHUB WEBSITE — wait for the workflow

Open your repository on GitHub, choose **Actions**, and open the run for the
push to `main`. Wait for all checks and the **Publish** steps to show green.
Within Publish, confirm the image smoke/health check also passed. The workflow
builds and publishes a commit-specific Linux ARM64 image to GHCR, then promotes
the convenient `:latest` tag. The optional
**Deploy** step should show as skipped unless automatic deployment has
deliberately been enabled.

The repository being public does **not** automatically make its GHCR package
public. After the first successful publish:

1. Open the account's **Packages** page on GitHub and choose the Phantom image
package.
2. Open the package settings and change its visibility to **Public**.
3. Confirm the change. This is separate from the source-repository visibility.

Public images can be pulled without a password or personal access token (PAT).
Do not add a PAT to the server just to pull a public image.

## Part 2 — Run the image on the server

### LAPTOP — connect to your existing server account

Run this command on your laptop. It opens a remote shell on the server; replace
the login and hostname with the values for your server:

```sh
ssh YOUR_SERVER_LOGIN@YOUR_SERVER_HOST
```

The login is a Linux user on the server. It is not your laptop account or your
GitHub account. For manual deployment you do not need to create a new
`deploy-user`, make an SSH key for GitHub, or add GitHub SSH secrets. The server
account does need permission to use Docker.

After you connect, commands explicitly labeled **SERVER** below are entered at
the remote shell prompt, not in a separate laptop terminal.

### SERVER — confirm Docker is ready

Check that the server is ARM64 and has Docker Compose v2:

```sh
uname -m
docker --version
docker compose version
```

`uname -m` should normally report `aarch64`. Docker Compose should support
`up --wait`. If Docker is not installed or your account cannot run Docker, ask
the server administrator to set that up before continuing. Docker access is
powerful: it is effectively administrator/root-level access on that server.

### SERVER — create a Compose configuration

Create a folder in your account's home directory, then open a new file in a
terminal editor:

```sh
mkdir -p ~/phantom
cd ~/phantom
nano compose.yaml
```

Paste this complete configuration. Replace `ghcr.io/example/phantom` with the
GHCR image path shown on your GitHub package page. Replace the example hostname
with the exact public HTTPS hostname you will configure in Caddy. Set `TZ` to
your calendar timezone (or leave it as `UTC` if that is what you want).

```yaml
services:
  phantom:
    image: ghcr.io/example/phantom:latest
    platform: linux/arm64
    init: true
    restart: unless-stopped
    read_only: true
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "3001"
      DATA_DIR: /app/data
      PUBLIC_ORIGIN: https://phantom.example.com
      TZ: UTC
    ports:
      - "127.0.0.1:3100:3001"
    volumes:
      - phantom-data:/app/data
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 512m
    cpus: 1.0
volumes:
  phantom-data:
    name: phantom-data
```

In `nano`, save with **Ctrl+O**, press **Enter**, then exit with **Ctrl+X**.
The stable explicit volume name (`phantom-data`) keeps the database when you
update or recreate this container. The port is bound to server loopback only;
visitors reach the app through Caddy, not directly on port 3100. The container
runs as the non-root user built into the image, with a read-only filesystem and
restricted capabilities. The image already defines a Docker health check for
`/api/health`; Compose uses it when `--wait` waits for startup.

### SERVER — download, start, and check Phantom

These commands run on the server, in `~/phantom`:

```sh
cd ~/phantom
docker compose pull
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3100/api/health
```

The health command should return JSON indicating the service is healthy. If
`pull` says access is denied, first check the image path and make the GHCR
package public as described above. If `up` fails, inspect the recent container
logs:

```sh
docker compose logs --tail 100 phantom
```

## Part 3 — Put Caddy and HTTPS in front

Caddy handles public HTTPS and temporary password protection. Phantom listens
only on the server's loopback port, so Caddy on the same server can proxy to
`127.0.0.1:3100`.

### SERVER — add a protected Caddy site

Make an account-specific bcrypt password hash without putting the plaintext
password in a command or file:

```sh
caddy hash-password
```

Merge a site like this into the server's **existing** Caddy configuration. Use
your hostname, a username of your choice, and the hash printed by
`caddy hash-password`:

```caddyfile
phantom.example.com {
    basic_auth {
        YOUR_USERNAME YOUR_BCRYPT_HASH
    }
    reverse_proxy 127.0.0.1:3100
}
```

Basic authentication must protect the entire hostname, including API routes.
Do not replace the existing Caddy configuration: that could interrupt other
hosted websites. Keep the plaintext password and resulting hash out of GitHub
and public source. The same snippet is available at
`deploy/Caddyfile.example` in the project repository.

Before editing, make a dated backup of the current configuration. The following
commands assume a systemd installation with the file at
`/etc/caddy/Caddyfile`; verify the actual path and service setup on your server
first. If you have no existing configuration, create one at the correct path
instead of making a backup.

```sh
sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%Y%m%d-%H%M%S)-$$"
sudo nano /etc/caddy/Caddyfile
```

In the editor, go to the end and append the Phantom site block. Do not select,
erase, or replace the existing file. Save and exit. Then validate the full
configuration:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
```

Only if validation succeeds, reload Caddy:

```sh
sudo systemctl reload caddy
```

If validation fails, **do not reload**. Correct the merged configuration first.
The example uses Caddy 2.8+ `basic_auth`; older releases used the `basicauth`
directive.

### DNS PROVIDER WEBSITE — configure the hostname's DNS

At the DNS provider for your domain, create an A record for the chosen
hostname pointing to the server's public IPv4 address. Add an AAAA record only
if the server is reachable over IPv6. Make sure network/provider firewalls allow
public HTTP and HTTPS to Caddy (ports 80 and 443). Do not expose port 3100.

### LAPTOP — test the public site

From your laptop, check that unauthenticated requests are challenged with HTTP
401 (replace the example hostname):

```sh
curl -I https://phantom.example.com/
curl -I https://phantom.example.com/api/state
```

Then open `https://phantom.example.com/` in a browser, enter the Caddy username
and password, create a practice, and reload the page. Try a prompted journal
entry too. Confirm the entry remains after a server-side container restart.
To restart the container, open a second laptop terminal, connect over SSH, then
run this at the remote server prompt:

```sh
cd ~/phantom
docker compose restart phantom
```

Return to the browser and reload the app to confirm the saved entry remains.

## Updating Phantom later

### LAPTOP — push the update

Commit and push your intended changes to `main`, as in Part 1. Stage only files
meant for the public repository. No Docker build is needed on your laptop.

### GITHUB WEBSITE — confirm the image is ready

Open **Actions** and wait for checks, ARM64 image publication, smoke test, and
the `:latest` promotion to pass. This alone does not change the container
already running on your server.

### SERVER — update the running service

Before a significant update, export a JSON backup in Phantom using its backup or
export feature and keep a copy somewhere safe. Do this in the browser before
typing the server commands below. Then run:

```sh
cd ~/phantom
docker compose pull
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3100/api/health
```

Compose replaces the old container while keeping the `phantom-data` volume.
There is no need to run `docker compose down` first. **Never run
`docker compose down -v`** for normal updates: `-v` removes the database volume.

If the update is unhealthy, inspect logs and the app's backup before taking
further action:

```sh
docker compose logs --tail 100 phantom
docker compose ps
```

Changing back to an older image does not reverse database migrations. Restore
from a verified application backup only when needed.

## Optional: automatic deployment from GitHub

Skip this section unless you specifically want GitHub to SSH to the server and
update it automatically. Manual deployment above does not need a `deploy-user`,
GitHub SSH key, or deployment secrets.

The optional deployment lane is gated by the repository Actions variable
`AUTO_DEPLOY=true`. When enabled, successful image checks trigger a server
deployment using the published immutable image digest (or commit-specific tag),
not the mutable `:latest` tag. It uses the repository's managed `/opt/phantom`
deployment files, SSH, a verified host key, and a server Linux account permitted
to run Docker. This is separate from the simple `~/phantom` manual Compose
setup. Do not enable the variable until the managed-stack setup and migration
have been deliberately completed.

For automatic deployment, an administrator creates/chooses a dedicated server
Linux login (often named `deploy-user`) and configures a dedicated SSH key,
verified host-key entry, and the workflow's required GitHub environment secrets:
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and `DEPLOY_KNOWN_HOSTS` in the
`production` environment. `DEPLOY_PORT` is an optional repository Actions
variable (defaults to SSH port 22). Set repository Actions variable
`AUTO_DEPLOY` to the exact value `true` only after the managed server setup is
ready. That login is only a server account: it is not a GitHub account and not a
new laptop account. Docker group membership grants effectively root-level
access. Protect the private key and workflow write permissions carefully. For
public GHCR images, no registry PAT is needed on the server.

### Moving from manual `~/phantom` Compose to automatic `/opt/phantom`

Do not just start the managed Compose stack alongside the manual one: both
would try to use the same host port and data. The managed deploy script also
expects a recorded immutable image tag/digest in its environment file; a
standalone `:latest` setup is not a safe starting state for that rollback logic.

Plan a maintenance window. Export and verify an application JSON backup first.
Record the exact image used by the healthy running container; the managed
deploy script needs that reference in immutable form (commit-SHA tag or GHCR
digest), not `:latest`. Prepare the managed files and its `.env` in `/opt/phantom`
without starting the service yet. Check that its Compose file sets the same
explicit volume name `phantom-data`, the same public origin, timezone, and port.
Then stop the `~/phantom` service with `docker compose down` (never add `-v`),
confirm no Phantom container is still listening on port 3100, and start the
managed service. Verify
health and existing entries before enabling `AUTO_DEPLOY=true`.

Do not run the two Compose projects at once, copy a `.env` containing `:latest`
into the managed deployment and assume it is ready, or run `down -v`. If the
immutable image state or volume mapping is unclear, leave automation disabled
and continue manual updates until an administrator has reconciled the managed
files with the running image. Never delete the volume as part of migration.

## Key safety rules

- Keep database data in `phantom-data`; never remove it during routine updates.
- Keep Caddy in front of the app, require authentication for every app/API route,
  and do not expose port 3100 publicly.
- Do not put passwords, private keys, or private application data in Git,
  container images, or public documentation.
- Backups on the server do not protect against losing the server. Keep a tested
  backup copy somewhere else.
