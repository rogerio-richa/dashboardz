# Dashboardz admin

This directory contains the React/TypeScript control panel for a Dashboardz
hub. It manages devices and pairing codes, screens and widgets, data sources,
themes, senders, agent tokens, alerts, and storage settings. The hub serves
the built panel at `/admin`.

## Commands

Run these from the repository root:

```bash
npm --prefix hub/admin ci
npm --prefix hub/admin run dev
npm --prefix hub/admin test
npm --prefix hub/admin run typecheck
npm --prefix hub/admin run lint
npm --prefix hub/admin run build
```

`dev` starts Vite, normally at `http://localhost:5173/admin/`, and proxies
`/admin/api`, `/api`, and `/sounds` to a hub at `localhost:8484`. Start the hub
in another terminal with `ADMIN_PASSWORD` and `PUBLIC_URL` set. `test` runs
the browser-oriented Vitest suite; `typecheck` uses TypeScript project-build
mode; `lint` runs Oxlint.

## Build output

`npm --prefix hub/admin run build` runs `tsc -b` and Vite, writing the bundle
to `hub/static/admin/`. That directory is generated and ignored by Git. A
fresh checkout has no bundle, so build it before running hub server tests or
before checking the hub's static `/admin` route.

## API boundary

The admin UI talks to the hub through `src/api.ts`, using same-origin session
cookies and the `/admin/api/*` endpoints. Login establishes the session;
unauthorized responses return the UI to the login screen. The panel does not
open a database connection or implement alert, pairing, or validation rules:
those remain hub responsibilities in `hub/src/`.

## Shared widget boundary

The browser device runtime and the admin preview use the same JavaScript
widget designs from `hub/static/device/widgets/`. A design draws against the
portable canvas surface and receives the hub's widget contract; it has no
React or DOM dependency. When changing a widget, update the shared module,
catalogue/definitions, and the relevant device and admin tests together. The
admin bundle does not copy a second widget implementation.
