# Contributing to Dashboardz

Thanks for wanting to help. This page is short on ceremony and long on the
few rules that keep the project honest.

## Getting a dev setup

The [development guide](docs/development.md) maps each component and its
boundaries. The commands below are the canonical setup and verification path.

Install **Node.js >= 22** (`.nvmrc` provided — `nvm use`), **Python 3**,
**Docker**, and a **JDK 17** for Android work. From the repository root, run
the canonical setup and verification commands (the scripts also resolve the
repository correctly when invoked by an absolute path from elsewhere):

```bash
./scripts/setup-dev.sh
./scripts/check-all.sh
```

Setup installs each Node package, creates the ignored root `.venv`, installs
the Meshtastic and MkDocs dependencies, and builds the admin bundle and MCP
CLI. The admin build is a prerequisite for hub tests: `hub/static/admin/` is
ignored and a fresh checkout otherwise has no bundle for the server test to
serve. The MCP build creates the ignored `clients/mcp/dist/cli.js` entrypoint
used by the repo-local agent configuration.

For focused work, use the package-local commands below. The test suites run
against throwaway data and do not touch a live hub:

- Hub: `npm --prefix hub test`, `npm --prefix hub run typecheck`.
- Admin UI: `npm --prefix hub/admin test`, `npm --prefix hub/admin run lint`.
- Relay: `npm --prefix relay test`.
- Sender client: `npm --prefix clients/sender test`.
- MCP server: `npm --prefix clients/mcp test`.
- Claude assistant: `npm --prefix integrations/claude/assistant test`.
- Claude hooks: `sh integrations/claude/hooks/test_hooks.sh` (dry-run, no hub needed).
- Meshtastic: `.venv/bin/python -m unittest discover -s integrations/meshtastic -p 'test_*.py'`.
- Docs: `.venv/bin/mkdocs serve` or `.venv/bin/mkdocs build --strict`.
- Android: `apps/android/gradlew -p apps/android test` (JDK 17).

Run the whole deployment with the README's four-command Docker Compose path;
component tests and local source development do not require starting it.

## The rules that matter

- **Tests come with the change.** Behavior the tests don't pin is behavior
  the next refactor deletes. Bug fixes start with a failing test.
- **Docs are part of the change, not a follow-up.** `docs/` is checked by
  tests in places (the screen guide must name every config key the schema
  accepts) — but the rule is broader: if your change makes a sentence in
  `docs/` or a README false, fixing that sentence is part of your PR.
- **Integrations are built from the public docs only.** Anything under
  `integrations/` must be buildable by a stranger from `docs/integrations.md`
  and the architecture pages alone. If you needed to read hub source to make
  your integration work, you found a documentation bug — fix the doc first,
  then use the doc. This is the point of the examples, not a style rule.
- **No planning artifacts in the repo.** Plans, TODOs, scratch notes, and
  design drafts don't get committed — only canonical docs do.
- **The hub never learns integration concepts.** An integration is an
  external process holding a sender token. If your feature needs the hub to
  know what a "Meshtastic channel" (or equivalent) is, the design is wrong.

## Sending changes

Fork, branch, and open a pull request against `main`. Keep PRs to one
subject; a commit message that explains *why* beats one that repeats the
diff. If the change touches behavior a device renders, a screenshot from a
real panel in the PR description is worth a paragraph.

## Licensing of contributions

Each component keeps its own license (see [License](README.md#license)):
the repository default is AGPL-3.0-only, including the hub (and `hub/admin`),
relay, and components without their own license file. The explicit MIT
exceptions are `clients/sender`, `clients/mcp`, `integrations/claude/assistant`,
and `apps/android`; each has a local `LICENSE`. By contributing, you agree
your contribution is licensed under the license of the component it touches.
