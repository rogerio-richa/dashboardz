# Getting started

This guide takes a fresh checkout from zero to a paired screen and a test
notification. You need Docker with Compose v2, a browser, and a host that the
other devices on your network can reach. `curl` is useful for the checks below.

## 1. Start the hub

From the repository root, copy the public examples and edit the two required
values before starting the container:

```bash
cp .env.example .env
# edit ADMIN_PASSWORD and PUBLIC_URL in .env
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Set `PUBLIC_URL` to the address that phones and browsers can actually open,
such as `http://192.168.1.20:8484`. It is embedded in the pairing QR code.

**You should see:** `docker compose ps` reports the `hub` service as running.

## 2. Check health and open the admin

Check the hub directly:

```bash
curl http://192.168.1.20:8484/api/health
```

Replace the address with your `PUBLIC_URL` host and port. A healthy hub
returns JSON containing `"ok":true` and `"name":"Dashboardz"`.

Open `http://192.168.1.20:8484/admin` in a browser and sign in with the
`ADMIN_PASSWORD` from `.env`.

**You should see:** the Dashboardz admin UI, including the Devices and Senders
tabs.

## 3. Pair a browser device

1. In **Devices**, enter a name and choose **Add device**. The admin shows a
   six-character code and a QR code; both expire after 10 minutes.
2. On the screen you want to use, open
   `http://192.168.1.20:8484/device` and enter the code. The Android app can
   scan the QR code; the browser view accepts the code by hand.
3. Tap the browser screen once immediately after pairing. Browsers suspend
   audio until a user gesture, so a fresh tab, kiosk restart, or reboot stays
   silent until that first tap. Later alerts can then play their configured
   sound.

Pairing returns a device to the hub and creates a starter screen: a full-screen
clock named after the device. Use **Screens → Edit** to add widgets, or assign
additional screens as tabs from **Devices**.

**You should see:** the device leaves the pairing form, displays its clock, and
appears online in the admin. A critical alert can take over the browser screen
and sound after the first tap.

## 4. Send a notification

In **Senders**, create a sender (for example, `quickstart`). Copy its token;
the token is shown only once. The Devices table does not display internal ids,
so the block below logs in, discovers the newest device through the authenticated
devices API, and sends the test alert. It leaves no cookie file behind when it
finishes:

```bash
(
  set -eu
  umask 077
  HUB_URL='http://192.168.1.20:8484'
  SENDER_TOKEN='dbz_s_...'
  COOKIE_JAR=$(mktemp "${TMPDIR:-/tmp}/dashboardz-admin.XXXXXX") || {
    echo 'Could not create a private temporary cookie jar.' >&2
    exit 1
  }
  cleanup() { rm -f "$COOKIE_JAR"; }
  trap cleanup 0
  trap 'exit 1' 1 2 3 15

  curl -fsS -c "$COOKIE_JAR" \
    -X POST "$HUB_URL/admin/api/login" \
    -H 'content-type: application/json' \
    -d '{"password":"REPLACE_WITH_ADMIN_PASSWORD"}' || {
      echo 'Admin login failed; check HUB_URL and password.' >&2
      exit 1
    }
  DEVICES_JSON=$(curl -fsS -b "$COOKIE_JAR" "$HUB_URL/admin/api/devices") || {
    echo 'Could not read devices from the hub.' >&2
    exit 1
  }
  printf '%s\n' "$DEVICES_JSON"
  DEVICE_ID=$(printf '%s' "$DEVICES_JSON" | sed -n 's/.*"id":"\(dev_[^"]*\)".*/\1/p')
  test -n "$DEVICE_ID" || {
    echo 'No devices found; pair a device first.' >&2
    exit 1
  }
  printf 'Using newest device: %s\n' "$DEVICE_ID"

  curl -fsS -X POST "$HUB_URL/api/notify" \
    -H "Authorization: Bearer $SENDER_TOKEN" \
    -H 'content-type: application/json' \
    -d "{\"title\":\"Dashboardz is working\",\"body\":\"First notification\",\"severity\":\"info\",\"devices\":[\"$DEVICE_ID\"]}" || {
      echo 'Notification failed; check SENDER_TOKEN, DEVICE_ID, and HUB_URL.' >&2
      exit 1
    }
)
```

`GET /admin/api/devices` returns a JSON array of device objects, each beginning
with an `id` such as `dev_...`; the hub orders that array by creation time, so
the extraction selects the newest device. The cookie supplies the
authentication required by this admin endpoint. Replace the address and both
placeholders in the block. The sender token authenticates the notification;
`severity` is `info`, `warn`, or `critical`, and `devices` is an explicit list
of device ids. If the request succeeds, the response contains an `id` and the
alert appears on the paired screen.

**You should see:** a JSON response such as `{"id":"alr_..."}` and the
notification on the device.

## Where to go next

- [Screens and widgets](architecture/screens.md) explains boards, tabs,
  widgets, themes, and data feeds.
- [Building an integration](integrations.md) documents sender tokens, feeds,
  questions, and the optional relay.
- [Development](development.md) is the map for changing the hub, admin, widget
  runtime, integrations, or Android app.
- [Architecture overview](architecture/overview.md) explains the hub's data
  paths and boundaries.
