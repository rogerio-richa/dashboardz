# Data sources

[`hub/src/sources`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/src/sources) is the hub collecting data for itself:
built-in providers (weather, RSS/Atom news, ICS calendars) that run on a
schedule and write into ordinary feeds. Everything downstream of the feed (the
`DATA` push, widgets) is the same as for a sender push. The concepts
(contracts, capabilities, drafts) are explained in
[Data sources](../architecture/data.md), including how to write a provider.

## Start here

1. [`provider.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/provider.ts): `ProviderDefinition`, the
   interface a provider implements: metadata, `potential_outputs`, `setup`
   fields, `validateSetup` and `run`. Also the small setup parsers
   (`setupText`, `setupHttpUrl`, ...).
2. [`registry.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/registry.ts): `BUILTIN_PROVIDERS`. Each
   provider is validated at import time against the known capabilities of the
   contracts it claims to produce.
3. [`loop.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/loop.ts) and [`run.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/run.ts):
   the scheduler (every 60 seconds, one pass at a time) and `runSourceOnce`,
   which opens the source's secrets, calls the provider, checks the outputs
   and writes them.

## From a schedule to a feed

1. `startSourceLoop` asks [`db/sources.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/sources.ts) for due
   sources and runs each in turn.
2. `runSourceOnce` decrypts the source's secrets with the secret box, calls
   `provider.run` with the injected `fetch`, and passes the result to
   `checkProducedOutputs` ([`writeOutputs.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/writeOutputs.ts)),
   which validates it against [`data/contracts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/data/contracts.ts).
3. In one transaction, `writeOutputs` creates the output's feed on first run,
   writes a value, appends stream rows, or bumps an image revision, and
   `recordRun` stores health and the next run time.
4. For every feed whose content actually changed, the loop calls
   `onFeedPush`, which is `app.dataPusher.onFeedPush`.
5. A failure goes through `recordFailure`, which records the source's health
   state and next retry. Provider errors carry a typed code from
   [`errors.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/errors.ts) (`authentication_required`,
   `rate_limited`, `unreachable`, `invalid_response`).

## Drafts

[`drafts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/drafts.ts) lets an operator test a source
before committing to it. `testSourceDraft` runs the provider once and stores
the preview in `source_drafts` for one hour. The draft becomes a real source
either through `POST /admin/api/source-drafts/:id/promote` or when a screen
that binds it is saved (`materializeSourceDraft`, called by
[`screens/save.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/screens/save.ts)). `startDraftSweep` deletes
expired drafts.

## Providers

| Provider | Files | Notes |
| --- | --- | --- |
| Open-Meteo weather | [`providers/openMeteo.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/providers/openMeteo.ts) | Also `geocodePlaces`, behind `GET /admin/api/geocode`. |
| RSS/Atom news | [`providers/rss.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/providers/rss.ts), [`providers/rssItems.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/providers/rssItems.ts), [`xmlStructure.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/xmlStructure.ts) | Hand-rolled XML scanning, no parser dependency. |
| ICS calendar | [`providers/ical.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/providers/ical.ts), [`providers/icalEvents.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/sources/providers/icalEvents.ts) | Uses `node-ical` for recurrence; the URL is stored as a secret. |

## How it connects

The admin routes are in
[`routes/sourceAdmin.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/routes/sourceAdmin.ts) (providers,
drafts, sources, manual refresh, geocode, source choices for a widget). Boot
wiring is in [`boot.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/boot.ts). Secrets use
[`secrets/box.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/secrets/box.ts); rows live in
[`db/sources.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/sources.ts) and
[`db/sourceDrafts.ts`](https://github.com/rogerio-richa/dashboardz/blob/main/hub/src/db/sourceDrafts.ts).

## Things that trip people up

- **There is one scheduler.** The v18 connector runtime is gone (its rows
  migrated in v19); `sourceArchitecture.test.ts` fails if a second loop or a
  provider without a consuming widget appears.
- **Never call the global `fetch` in a provider.** Use the `fetch` in the run
  context (`app.sourceFetch`), so tests run from fixtures and never touch the
  network.
- **Provider fetches are capped.** `fetchProvider` applies a 10 second timeout
  and honours `Retry-After`; `readCappedText`/`readCappedJson` cap body size.
- **A run that loses a race does not write.** `runSourceOnce` re-reads the
  source revision inside the transaction and drops the result if the source
  was edited or deleted meanwhile.
- **Scheduler runs audit as `system`,** manual refreshes as the admin or agent
  that asked.

## Tests

`sourceLoop.test.ts`, `sourceRun.test.ts`, `sourceDraftService.test.ts`,
`sourceDrafts.test.ts`, `sources.test.ts`, `sourceAdminApi.test.ts`,
`sourceArchitecture.test.ts`, `providerRegistry.test.ts`,
`providerOpenMeteo.test.ts`, `providerRss.test.ts`, `providerIcal.test.ts`,
`rssItems.test.ts`, `icalEvents.test.ts`, `connectorsApi.test.ts` (the
retired connector routes stay gone), with
fixtures in [`hub/test/fixtures`](https://github.com/rogerio-richa/dashboardz/tree/main/hub/test/fixtures). The end-to-end
journey from an empty hub to new data on a socket is `widgetFirstJourney.test.ts`.
