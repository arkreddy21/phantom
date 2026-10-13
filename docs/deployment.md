# Self-host Phantom with Docker Compose

The published CI image is currently **ARM64 only**. Check the server architecture
with `uname -m`: `aarch64` is ARM64, while `x86_64` is 64-bit x86. An x86-64
server cannot run the ARM64 image; use the local x86 build instructions below.

The example uses `ghcr.io/example/phantom:latest` as an unmistakable placeholder.
Replace it with the image path shown under this project's **Packages** on GitHub.
The package must be public for an anonymous `docker compose pull`; no PAT is
needed for a public image. A public source repository does not automatically
make its container package public.

The `:latest` tag is a movable label, not an auto-update feature. A running
container stays on its current image until you explicitly pull and recreate it.

## Prepare a published image

### LAPTOP — use a local image instead (x86-64 server only)

If the server reports `x86_64`, build a local image on the laptop and transfer it
to the server. Docker must be installed on the laptop, and the build must target
the server architecture. For an x86-64 laptop and server:

```sh
docker build --platform linux/amd64 -t phantom:local .
docker save phantom:local -o phantom-image.tar
scp phantom-image.tar YOUR_SERVER_LOGIN@YOUR_SERVER_HOST:~/phantom-image.tar
```

`YOUR_SERVER_LOGIN` and `YOUR_SERVER_HOST` are the SSH login and hostname you
already use to access the server. On the server, load the transferred image:

```sh
docker load -i ~/phantom-image.tar
```

In the Compose `.env` below, set `PHANTOM_IMAGE=phantom:local`. The local image
is not automatically refreshed by GHCR; rebuild, transfer, and load a new one
when you want to update it.

## First run on server

### create the Compose file

Create a private working directory and open a new Compose file:

```sh
mkdir -p ~/phantom
cd ~/phantom
nano compose.yaml
```

Paste the complete configuration below. It reads the image reference from
`PHANTOM_IMAGE` in `.env` and binds the app to local port 3001 only. The
platform defaults to ARM64 for the published CI image; the local x86-64 option
below sets it to AMD64.

```yaml
services:
  phantom:
    image: ${PHANTOM_IMAGE:?Set PHANTOM_IMAGE in .env}
    platform: ${PHANTOM_PLATFORM:-linux/arm64}
    init: true
    restart: unless-stopped
    read_only: true
    env_file:
      - .env
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "3001"
      DATA_DIR: /app/data
      AUTH_USERNAME: ${AUTH_USERNAME:?Set AUTH_USERNAME in .env}
      AUTH_PASSWORD: ${AUTH_PASSWORD:?Set AUTH_PASSWORD in .env}
      AUTH_TRUST_PROXY: ${AUTH_TRUST_PROXY:-0}
      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-http://localhost:3001}
      TZ: ${TZ:-UTC}
    ports:
      - "127.0.0.1:3001:3001"
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

The image runs as its built-in non-root user, has a read-only filesystem, and
gets a small writable temporary filesystem. The persistent volume is explicitly
named so its identity does not change if the folder or Compose project name
changes. The image includes a health check for `/api/health`, which Compose uses
with `--wait`.

### create the private `.env`

Compose reads the `.env` file for substitutions in `compose.yaml`. The
`env_file` also passes the variables into the application container. Create the
file beside `compose.yaml`:

```sh
cd ~/phantom
nano .env
```

Paste this content, replacing the example image with the package path shown in
GitHub Packages and replacing the username and password with unique values. For
a local image instead, use `PHANTOM_IMAGE=phantom:local`:

```dotenv
AUTH_USERNAME=choose-a-username
AUTH_PASSWORD=replace-with-a-long-random-password
AUTH_TRUST_PROXY=0  # set 1 only under a trusted proxy like your caddy
PUBLIC_ORIGIN=http://localhost:3001
TZ=UTC
PHANTOM_IMAGE=ghcr.io/example/phantom:latest
# For a locally built x86-64 image, replace the image above with phantom:local
# and add:
# PHANTOM_PLATFORM=linux/amd64
```

For an x86-64 local image, set `PHANTOM_IMAGE=phantom:local` and
`PHANTOM_PLATFORM=linux/amd64` in `.env`. For an ARM64 local image, use
`PHANTOM_PLATFORM=linux/arm64`. Choose a real timezone instead of `UTC` if you
want the app's daily dates to follow another timezone. Save and exit, then
protect the credentials file:

```sh
chmod 600 .env
```

Keep `.env` private; do not commit or share it. In Compose `.env` files, a
password containing `$` should be single-quoted, for example
`AUTH_PASSWORD='your$password'`. Avoid putting credentials in commands,
screenshots, or logs.

### pull and start Phantom

For the published image, `PHANTOM_IMAGE` in `.env` must contain the real GHCR
path from GitHub Packages, and the package must permit anonymous pulls. Run:

```sh
cd ~/phantom
docker compose pull
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3001/api/health
```

For a local image, set `PHANTOM_IMAGE=phantom:local` and the matching
`PHANTOM_PLATFORM` in `.env`, then omit `docker compose pull` and run:

```sh
cd ~/phantom
docker compose up -d --wait
docker compose ps
curl --fail http://127.0.0.1:3001/api/health
```

The health request should return a successful response. `127.0.0.1` means the
port is only accessible from the server itself, ready for an HTTPS reverse proxy
on that same server. To view it from your laptop without opening the app port,
create an SSH tunnel in a laptop terminal with
`ssh -L 3001:127.0.0.1:3001 YOUR_SERVER_LOGIN@YOUR_SERVER_HOST`, then open
`http://localhost:3001` in a laptop browser. For remote access, set up HTTPS
below. If pull is denied, confirm the image path and package visibility. For
startup problems, inspect:

```sh
docker compose logs --tail 100 phantom
```

## Put a reverse proxy in front

To reach Phantom remotely, use HTTPS via a reverse proxy such as Caddy, running
on the same server. Keep the Compose loopback-only port mapping; do not expose
port 3001 directly to the internet. Configure the proxy for your own hostname,
and forward requests to `127.0.0.1:3001`. For example, a Caddy site block is:

```caddyfile
your-hostname.example {
    reverse_proxy 127.0.0.1:3001
}
```

Configure DNS for that hostname to point to the server and allow HTTP/HTTPS
traffic to the reverse proxy. Preserve any existing proxy configuration and
protect all application routes. Before applying a change to an existing Caddy
configuration, make a backup, append the site block rather than replacing the
file, validate the full configuration, and only then reload Caddy. Exact paths
and service commands depend on how the proxy was installed.

### SERVER — update `.env` for HTTPS

Set `PUBLIC_ORIGIN` to the exact HTTPS origin (scheme and hostname, no path),
and set `AUTH_TRUST_PROXY=1` only when the app is reachable exclusively through
one trusted proxy hop. For example:

```dotenv
PUBLIC_ORIGIN=https://your-hostname.example
AUTH_TRUST_PROXY=1
```

Edit `.env`, preserving your actual username and password. Trust proxy
is disabled by default and must not be enabled if clients can directly reach the
app port or an untrusted container can connect to it. It lets the app use the
trusted proxy's forwarded client address for login throttling.

Apply the new origin and proxy settings by recreating the container:

```sh
cd ~/phantom
docker compose up -d --wait
```

### BROWSER — verify the HTTPS site

Open the HTTPS hostname you configured and sign in using the credentials from
the server `.env`. An unauthenticated API request should be rejected:

```sh
curl -i https://your-hostname.example/api/state
```

The login page is intentionally public. Create a test entry, refresh, and
confirm it remains. Confirm that private data and API operations require an
authenticated application session.

## Update the application

### BROWSER — back up important data

Before a significant update, use Phantom's export/backup feature and keep a copy
somewhere other than the server.

### SERVER — pull and replace the container

After the image has been published, run:

```sh
cd ~/phantom
docker compose pull
docker compose up -d --wait
docker compose ps
```

Compose replaces the container while keeping the `phantom-data` volume. There is
no need to run `docker compose down` first. **Never use `docker compose down -v`
for a routine update**: `-v` removes the database volume. For a local image,
rebuild and load the replacement image before running `docker compose up -d
--wait` (and omit `docker compose pull` if that image is not published).

If the new container is unhealthy, check its status and logs:

```sh
docker compose ps
docker compose logs --tail 100 phantom
```

Returning to an older image does not undo database migrations. Restore from a
verified application backup only when needed.

## Troubleshooting and safety

- **Pull says denied:** Check the exact package image name and make sure the GHCR
  package is public. A public source repository alone is not enough.
- **No matching image platform:** The published CI image is ARM64-only. For
  `x86_64`, build an `amd64` image locally and set `PHANTOM_IMAGE` as described
  above.
- **Container does not start:** Run `docker compose ps` and
  `docker compose logs --tail 100 phantom`; fix the reported issue before
  changing the volume or deleting anything.
- **Browser origin/authentication errors:** Confirm that `PUBLIC_ORIGIN` exactly
  matches the URL in the browser. For HTTPS, use `https://` and the exact
  hostname. Trust proxy is only for the single trusted reverse-proxy setup.
- **Protect the data:** Keep the `phantom-data` volume, protect `.env`, and keep
  tested backups off-server. Do not run `docker compose down -v` unless you
  intentionally want to delete the database.

Manual Compose deployment does not need an SSH deployment account or GitHub
deployment secrets. GitHub-to-server automatic deployment, if separately
configured, is an optional advanced setup and is not needed to follow this guide.
