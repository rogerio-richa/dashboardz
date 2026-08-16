#!/usr/bin/env bash
#
# Read the LIVE hub database safely.
#
#   scripts/hub-sql.sh "SELECT id, screen_id FROM devices;"
#   scripts/hub-sql.sh "PRAGMA user_version;"
#
# WHY THIS EXISTS — do not skip this: querying the live database from the host can lose writes.
#
# Running `sqlite3 hub/data/hub.db` from the macOS HOST while the hub container has the database
# open is DESTRUCTIVE, even for a plain SELECT. SQLite file locks do not cross Docker Desktop's
# virtiofs boundary, so the host process cannot see the container's connection, concludes it is the
# only one, and on exit checkpoints and UNLINKS `hub.db-wal` and `hub.db-shm`.
#
# The running hub is then holding deleted inodes — confirmed directly, its fd table shows
# `/data/hub.db-wal (deleted)`. From that moment its writes are visible to nobody else (the admin
# API and a host query will disagree about the same row, at the same instant), and if the process
# exits without closing the database those writes are freed with the inode. That is how a device's
# screen assignment vanished.
#
# So: never point host sqlite3 at a live database. This runs the query INSIDE the container, on the
# same connection's filesystem view, in READ-ONLY mode, which takes no lock the hub cares about and
# creates no journal of its own.
#
# If the container is not running there is no live writer, and reading the file directly from the
# host is fine — this script says so rather than silently doing something different.
set -euo pipefail

CONTAINER="${HUB_CONTAINER:-dashboardz-hub}"

if [ $# -eq 0 ]; then
  echo "usage: $0 \"<SQL>\"" >&2
  exit 64
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "note: '$CONTAINER' is not running — no live writer, so host sqlite3 is safe here:" >&2
  echo "      sqlite3 hub/data/hub.db \"$1\"" >&2
  exit 69
fi

# better-sqlite3 ships in the image; sqlite3(1) does not. readonly:true means this cannot create or
# truncate a WAL, and cannot write.
docker exec -i "$CONTAINER" node -e '
const Database = require("/app/node_modules/better-sqlite3")
const db = new Database("/data/hub.db", { readonly: true })
try {
  const sql = process.argv[1]
  const stmt = db.prepare(sql)
  // .get()/.all() throw on statements that return nothing (PRAGMA writes, DDL); .run() covers those.
  const rows = stmt.reader ? stmt.all() : [stmt.run()]
  for (const row of rows) console.log(Object.values(row).join("|"))
} finally {
  db.close()
}
' "$1"
