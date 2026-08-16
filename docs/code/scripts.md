# Scripts and CI

Repository-level tooling: the setup and verification scripts in
[`scripts/`](https://github.com/rogerio-richa/dashboardz/tree/main/scripts), the hub's helper scripts in
[`hub/scripts/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/scripts), and the CI workflow. The commands
themselves are documented in the [development guide](../development.md); this
page says what each file does.

## `scripts/`

| File | What it does |
| --- | --- |
| [`setup-dev.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/setup-dev.sh) | `npm ci` in every Node package, creates the ignored `.venv` with the Meshtastic and MkDocs dependencies, builds the admin bundle and the MCP CLI. Refuses Node older than 22. |
| [`test-setup-dev.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/test-setup-dev.sh) | Smoke test for `setup-dev.sh`: runs it against a fake checkout with a stubbed `npm` and checks what it invoked. |
| [`check-all.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/check-all.sh) | The full contributor check: the code-docs check, the setup smoke test, every package's tests, typecheck and build, admin lint, Claude hooks, Meshtastic tests, the strict MkDocs build, Compose validation and Android unit tests. |
| [`check-code-docs.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/check-code-docs.mjs) | Fails when these docs/code pages drift from the tree (below). |
| [`check-typecheck-scope.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/check-typecheck-scope.mjs) | Run by each package's `typecheck` script: asks `tsc --listFilesOnly` for the program and fails if any test file is missing from it. |
| [`hub-sql.sh`](https://github.com/rogerio-richa/dashboardz/blob/main/scripts/hub-sql.sh) | Runs a read-only SQL query inside the running hub container. Use it instead of host `sqlite3`, which can unlink the live WAL. |

## `hub/scripts/`

| File | What it does |
| --- | --- |
| [`demo-data.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/scripts/demo-data.mjs) | Fills a running hub with demo senders, feeds and a screen through the real HTTP API, then pushes plausible data on a loop. Idempotent, keyed by name. Flags: `--once`, `--setup`, `--loop N`, `--sound`, `--no-alerts`, `--reset-screen`. |
| [`gen-sounds.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/scripts/gen-sounds.mjs) | Regenerates `hub/static/sounds/<family>/<event>.wav` deterministically. A diff in its output means `manifest.json`'s `rev` must bump. |

The relay's operator CLI, [`relay/scripts/token.mjs`](https://github.com/rogerio-richa/dashboardz/blob/main/relay/scripts/token.mjs),
is described on the [Relay server](relay.md) page.

## CI

[`.github/workflows/ci.yml`](https://github.com/rogerio-richa/dashboardz/blob/main/.github/workflows/ci.yml) runs five jobs:
hub and admin (tests, typecheck, build, lint), relay plus the clients and the
Claude assistant, Python plus MkDocs plus Compose validation, Android unit
tests, and a hub Docker build. It does not call `check-all.sh`; the code-docs
check reaches CI through the hub suite's `code-docs.test.ts`.
[`.github/dependabot.yml`](https://github.com/rogerio-richa/dashboardz/blob/main/.github/dependabot.yml) configures dependency
updates.

## The code-docs check

`node scripts/check-code-docs.mjs` exits non-zero and lists every problem when:

1. a code link in a docs/code page does not resolve. Code is linked through
   its GitHub URL (`.../blob/main/<file>` or `.../tree/main/<dir>`) so links
   work on GitHub and on the published site; the script maps each URL back to
   the checkout and requires the file or directory to exist. Relative links
   must be doc pages inside `docs/`.
2. a code section has no page linking into it. Sections are read from the
   filesystem: each directory under `apps/`, `clients/`, `integrations/` and
   `hub/src/`, each `.ts` file directly in `hub/src/`, plus `hub/admin`,
   `hub/static/device`, `hub/static/device/widgets`, `hub/static/sounds`,
   `hub/test`, `hub/scripts`, `relay` and `scripts`. A new folder or a new
   root hub file therefore fails until a page covers it.
3. a page is missing from [the index](index.md) or from the `mkdocs.yml` nav.

It runs first in `check-all.sh` and as
[`hub/test/code-docs.test.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/code-docs.test.ts). It only checks
that links resolve and sections are covered; keeping each page's prose true is
the author's job, in the same change as the code.
