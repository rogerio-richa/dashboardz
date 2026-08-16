# Agent instructions

Contribution rules for this repository are in [CONTRIBUTING.md](CONTRIBUTING.md);
the setup and check commands are in [docs/development.md](docs/development.md).

## Keep the code map in sync

[`docs/code/`](docs/code/index.md) has one page per code section (hub server
folders, admin, board runtime, widgets, tests, Android, relay, clients,
integrations, scripts). Any change that adds, moves, renames, or changes the
responsibility of code in a section must update the matching `docs/code` page
in the same change. A new section needs a new page, listed in
`docs/code/index.md` and in the `mkdocs.yml` nav.

Before finishing, run `node scripts/check-code-docs.mjs`. It fails when a page
links to a path that no longer exists, when a code section has no page, or
when a page is missing from the index or nav. It does not check that the prose
is still accurate; reread the page you touched.
