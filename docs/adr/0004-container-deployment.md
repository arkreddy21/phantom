# ADR 0004: Deploy immutable ARM64 containers behind host Caddy

Status: Accepted  
Date: 2026-10-11

## Context

The application needs a repeatable deployment that works on an ARM64 Linux host
with host-installed Caddy. The source repository and published application image
may be public. Application data must survive image replacement. The application
still has no identity or authorization model.

## Decision

GitHub Actions validates the project, builds a Linux ARM64 container, and publishes
it to GHCR. Successful main-branch runs deploy an immutable image reference via
SSH to a dedicated Docker Compose stack. The instance pulls images rather than
building the project. Pin each deployment to its published digest; commit-SHA
tags provide a recognizable version, not a mutable `latest` deployment target.

Host Caddy terminates HTTPS for the configured public hostname and protects every
route with basic authentication until in-app authentication is introduced. The
container publishes only a host loopback port. A dedicated named volume holds
SQLite data; images contain no personal database or credentials. Set
`PUBLIC_ORIGIN` explicitly so HTTPS browser writes are accepted behind the
internal HTTP proxy without trusting arbitrary forwarded headers. Set the
server's timezone deliberately.

Deployments serialize, pull before replacing the running container, preserve a
pre-deployment logical backup, wait for health, and attempt an image rollback on
failure. Do not prune unrelated images/volumes on this shared host. Verify SSH
host keys from a trusted connection rather than disabling verification.

## Consequences

- Public source/images contain code only; data, password hashes, SSH credentials,
  environment configuration, and backups remain private.
- Access to Docker is effectively root access. Limit the deployment SSH key/user
  and protect repository/workflow write access. Docker group membership is not
  a restricted privilege boundary.
- The host requires ARM64 Linux, Docker Compose v2, outbound GHCR access,
  persistent disk, and an inbound SSH path reachable from the Actions runner.
- A single replica means brief deployment downtime. This is proportionate for a
  personal tracker; redundant services would complicate SQLite ownership.
- Rollback restores the application image, not the database. Future schema
  migrations must be backward compatible or use a separately tested recovery
  procedure. Backups stored on this instance need an off-host copy to protect
  against loss of the instance itself.
- Container build/ARM runtime and live DNS/Caddy/SSH cannot be claimed verified
  from a development environment without Docker or remote-host access. CI and the
  documented live smoke checks close those boundaries.
