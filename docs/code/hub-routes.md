# HTTP routes

[`hub/src/routes`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/routes) holds every HTTP endpoint as a Fastify
plugin. `server.ts` registers the top-level plugins; the admin plugin then
registers its sub-modules from [`routes/admin/`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/routes/admin).
The public contract for senders is described in
[Senders](../architecture/senders.md) and the
[integration walkthrough](../integrations.md); this page is about where each
route lives and how it is guarded.

## Four credentials, four guards

| Caller | Credential | How it is checked |
| --- | --- | --- |
| Sender (script, integration) | `Authorization: Bearer dbz_s_...` | inline `findSenderByToken` in each sender route |
| Device (board page, Android) | `Bearer dbz_c_...` over HTTP, or `HELLO.token` on the socket | inline `findDeviceByToken` |
| Admin UI | `dbz_admin` session cookie | `requireAdmin` or `requireHumanAdmin` |
| Agent (MCP) | `Bearer dbz_a_...` | `requireAdmin` only |

Both guards live in [`admin/shared.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/shared.ts).
`requireAdmin` accepts a session cookie or an unrevoked agent token and stamps
`req.actor` for audit rows. `requireHumanAdmin` accepts only the cookie, so an
agent can never mint or revoke credentials, change the relay, dismiss alerts
from the console, or change retention.

## Where each route lives

| File | Endpoints | Guard |
| --- | --- | --- |
| [`notify.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/notify.ts) | `POST /api/notify`, `GET /api/alerts/:id/answer` | sender |
| [`feeds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/feeds.ts) | `POST /api/feeds/:id` (JSON or image bytes); `GET /api/feeds/:id/image` | sender; device |
| [`pair.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/pair.ts) | `POST /api/pair` | pairing code |
| [`themes.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/themes.ts) | `GET /api/themes/:id`, `GET /api/themes/:id/bg`; `PUT /admin/api/themes/:id/bg` | device; admin |
| [`agents.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/agents.ts) | `/admin/api/agent-tokens` list; create and revoke | admin; human |
| [`admin.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin.ts) | login, logout, and the admin scope below | none; human |
| [`sourceAdmin.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/sourceAdmin.ts) | providers, source drafts, sources, refresh, geocode, source choices | admin |
| [`admin/senders-devices.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/senders-devices.ts) | senders, devices, pairing codes, tabs, play-sound, reload | admin |
| [`admin/screens.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/screens.ts) | screens CRUD | admin |
| [`admin/themes.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/themes.ts) | themes CRUD | admin |
| [`admin/feeds.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/feeds.ts) | feeds CRUD, `feed-fit`, `widget-contract` | admin |
| [`admin/alerts-storage.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/alerts-storage.ts) | active alerts, audit log, storage stats; alert dismiss, retention | admin; human |
| [`admin/relay.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/admin/relay.ts) | `GET config`, `GET relay`; `PUT`/`DELETE relay`, `relay/test` | admin; human |

The device WebSocket (`/ws/device`) is not here; it lives in
[`ws/deviceSocket.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/ws/deviceSocket.ts) (see
[Device socket](hub-ws.md)).

## The usual shape of a handler

1. AJV validates the body from the route's `schema` (`removeAdditional` is
   off, so unknown keys are rejected, not stripped).
2. Authenticate; a rejected Bearer token writes an `auth_rejected` audit row.
3. Call a [`db/`](hub-db.md) module, or a service such as
   [`screens/save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts) or
   [`sources/drafts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/drafts.ts).
4. Push the change to devices: `app.registry.sendMany(...)` for alerts,
   `app.statePusher.push(deviceId)` for layout and theme changes,
   `app.dataPusher.onFeedPush(feedId)` for new data, `pushTabStatus` for tab
   dots. `admin/shared.ts` has `pushDevicesForScreens` and
   `pushDevicesForTheme` so every route fans out the same way.
5. Write an audit row through `audit(...)`, attributed with `actorOf(req)`.

## Things that trip people up

- **Guards are attached per plugin scope, not per route.** Add an admin route
  inside the existing `admin.register(...)` block and it is guarded by
  construction. A route registered on `app` directly is public.
- **Sessions must come from the root instance.** `app.sessions` is decorated
  in `server.ts` because Fastify decorators only flow parent to child; a store
  created inside a plugin would be invisible to its siblings.
- **Feed pushes are not audited** (a 5 second push loop would bury the log);
  the feed row's `pushed_at`/`pushed_by` records them instead, and its
  `rejected_*` columns record the last refused push.
- **Body limits live on content-type parsers.** `feeds.ts` caps JSON at 16 KB
  and images at `MAX_IMAGE_BYTES` on separate parsers sharing one route.
- **The push route authorizes in `onRequest`.** Token, feed and allowlist are
  checked before the body is read, so 401/404/403 come before 400/413/415 and
  an anonymous caller never reaches the code that records rejections.
- **`feeds.ts` has its own error handler.** It turns Fastify's parser errors
  into `{"error": "..."}` sentences that name what the feed takes, records the
  rejection on the feed (`recordFeedRejection`, reasons in
  [`feedRejections.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/feedRejections.ts)), and hides internal
  errors behind a generic 500.
- **`admin.ts` re-exports helpers** (`requireAdmin`, `WIDGET_FEED_MODES`, ...)
  for older importers; the implementations are in `admin/shared.ts` and
  `screens/save.ts`.
- **Validation errors are rewritten.** The server error handler passes AJV
  errors through [`validationMessage.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/validationMessage.ts).

## Tests

Route tests use `app.inject` through
[`support/inject.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/test/support/inject.ts): `notify.test.ts`,
`answers.test.ts`, `alertAnswer.test.ts`, `feedsApi.test.ts`,
`feedsPush.test.ts`, `pair.test.ts`, `admin.test.ts`, `agent-tokens.test.ts`,
`screensApi.test.ts`, `themesApi.test.ts`, `themesAdminApi.test.ts`,
`sourceAdminApi.test.ts`, `storageAdminApi.test.ts`, `adminAlerts.test.ts`,
`relayConfigApi.test.ts`, `relayStatusApi.test.ts`, `deviceTabsApi.test.ts`.
