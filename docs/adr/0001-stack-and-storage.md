# ADR 0001: A client-rendered app with a private SQLite API

Status: Accepted  
Date: 2026-10-11

## Context

This is a personal habit and prompted-journal tracker with expressive animation,
daily interactions, custom social stats, and server-side persistence. Public
content and search indexing are not requirements. Authentication is deferred,
but a future hosted version must not depend on a browser's local storage.

## Decision

Use pnpm, Vite, React, and TypeScript for the interactive client, with a small
Express JSON API and Node's built-in SQLite driver for durable storage. Use a
single origin in production and a Vite API proxy in development. Share domain
types between client and server, validate requests at the API boundary, and
keep persistence behind the API rather than exposing database access to UI code.

An Astro static-content architecture offers little benefit for this app's
interaction-heavy, private screens. A separate database service would add
operational overhead for a single user; SQLite provides transactions and a
portable data file without a service dependency.

## Consequences

- One persistent server and a writable data directory are required. This is not
  a static-only or ephemeral serverless deployment.
- Use a supported Node version with `node:sqlite`; the project declares its
  minimum version. The database API can be replaced later without changing UI
  components.
- There is intentionally no authentication. Bind to loopback by default. Before
  internet exposure, add authentication/authorization or protect the entire app
  behind a trusted authenticated reverse proxy. Origin checks are not access
  control.
- A hosted multi-user version will require explicit ownership on all persisted
  entities, authorized queries, and a reviewed migration. That is not simulated
  by adding unused user IDs now.
- No telemetry or remote content dependencies are necessary.
