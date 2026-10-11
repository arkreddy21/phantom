# MVP verification plan

## Claims and owners

| Claim | Validation owner | Evidence path |
| --- | --- | --- |
| Daily persistence survives process/database reopen | Backend implementer | Isolated temporary SQLite integration tests |
| Completion awards once; undo and recompletion are correct | Backend implementer | API transition tests including reward-setting changes |
| Prompted writing is required, invalid dates/data are rejected | Backend implementer | Negative API tests |
| Backups preserve history and invalid restore is atomic | Backend implementer | Roundtrip/invalid-import tests |
| UI represents actual API state and core flows work | Browser test implementer / orchestrator | Real browser against isolated API/database |
| Layout works at desktop and mobile sizes | Designer / orchestrator | Browser viewport checks and screenshot inspection |
| Production artifact and types are consistent | Orchestrator | Typecheck, tests, production build, production smoke |

## Browser scenarios

1. Load a fresh server; inspect seeded configuration and zero completed history.
2. Complete a check habit, see stat award, dismiss celebration, reload, and undo.
3. Open a prompted journal, reject empty input, submit writing, reopen/edit and
   verify no extra award. Browse the stored writing through dated history.
4. Create a custom stat and habit; verify the chosen reward is awarded.
5. Select past dates and month views; verify actual entries are browsable.
6. Export/restore where practical, check settings, mute, and keyboard dialogs.
7. At a narrow viewport, confirm no horizontal overflow and usable navigation.

Use an isolated data directory for browser tests, never a user's actual database.
Check visual screenshots in addition to DOM assertions. Browser audio rendering
cannot prove subjective similarity to a game sound; automated checks establish
that saved transitions produce the intended visual state, not artistic identity.

## Boundaries

Authentication, concurrent multi-user access, cloud deployment, cross-device
timezone reconciliation, long-duration performance, and subjective sound quality
are not established by local MVP tests. Internet hosting requires separate access
protection. Re-run affected checks after any corrective edits.

## MVP evidence — 2026-10-11

- `pnpm typecheck`: client and server passed.
- `pnpm test`: 11 API integration tests passed, covering validated input,
  reward idempotency/undo, snapshot preservation, journal writing, archive,
  persistence reopen, origin checks, size limits, and backup restore.
- `pnpm build`: compiled server and Vite client successfully.
- Exact `pnpm start` with isolated storage: `/` returned HTML, health returned
  JSON, and an unknown API route returned a JSON 404.
- `pnpm exec playwright test`: one comprehensive Chromium acceptance scenario
  passed against the actual Vite proxy and isolated SQLite database, without
  intercepting API requests. Covered completion/reload/undo, prompted writing
  and editing, custom stats/practices, dated history/month navigation,
  archive/restore, export/import, sound/reduced-motion preferences, modal focus,
  and mobile navigation. Console/page error checks passed.
- Final screenshots inspected for Today (desktop and 375px mobile), reward,
  Archive, and Stats. No horizontal overflow at 375px. Screenshots and traces
  are generated under ignored `test-results/`, not committed as source.

The backend, browser suite, and production smoke were validated by their
implementation lanes and reconciled by the orchestrator. Sound is synthesized;
automated browser checks do not establish subjective audio similarity. Firefox,
Safari, internet deployment, and authentication remain outside this evidence.

## Deployment evidence — 2026-10-11

The deployment change adds a distinct verification boundary: internal HTTP
requests behind public HTTPS must be accepted only for the configured public
origin, persistent data must outlive a container, and failed upgrades must not
silently discard the old image/configuration.

- API implementer: 13 API tests passed, including HTTPS origin acceptance,
  invalid configured origins, wrong/null origins, and forwarded-header spoofing.
- Orchestrator: client/server typechecks, 13 API tests, production build, and the
  existing Chromium acceptance scenario passed after the origin change.
- Deployment implementer: Bash syntax and mocked deploy failure/state tests.
  These establish script control flow, not actual Docker behavior.
- Workflow validation: upstream action SHA references checked; `actionlint`
  passed. ARM64 image startup was subsequently checked under emulation; native
  ARM64 verification remains pending as noted below.
- Reviewer: independent security/data-integrity review identified rollback
  configuration and image-state persistence error paths; corrections are covered
  by deployment-script tests.

## Docker evidence — 2026-10-12

- Both `linux/amd64` and `linux/arm64` images built from the current tree.
- `bash tests/container/smoke.sh` passed for both architectures: API health,
  production HTML/assets, accepted/rejected origins, backup export/import,
  nonroot/read-only execution, tmpfs, dropped capabilities, CPU/memory limits,
  and dated journal content surviving container recreation with a named volume.
- Real ARM64 Compose startup, entry persistence after force-recreation, and
  `backup.sh` JSON validation and permissions (file `0600`, directory `0700`)
  passed with isolated test resources. Compose configuration validation passed.
- Client/server typechecks, 13 API tests, 12 mocked deployment tests, production
  build, Chromium acceptance, and workflow linting passed.
- Private build-context directories were excluded and absent from the image.

ARM64 runtime checks used emulation on an x86-64 host, not native ARM hardware.
No remote SSH connection, GHCR publication, DNS change, or Caddy reload was
performed. The manual live checks in `docs/deployment.md` remain required before
claiming live deployment.
