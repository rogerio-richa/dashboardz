import { describe, expect, it } from 'vitest'
import { openDb, type DB } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createFeed } from '../src/db/feeds.js'
import { createScreen } from '../src/db/screens.js'
import { setDeviceTabs } from '../src/db/devices.js'
import { ingestNotify, recordTap } from '../src/db/alerts.js'
import { computeTabStatus, pushTabStatus, screensLitBySender } from '../src/ws/tabStatus.js'

/** Registry stand-in: records sends, reports online devices (dataPush.test.ts's pattern). */
class FakeRegistry {
  sent: Array<{ deviceId: string; msg: any }> = []
  online = new Set<string>()
  isOnline(id: string) { return this.online.has(id) }
  send(id: string, msg: object) { this.sent.push({ deviceId: id, msg }) }
  sendMany(ids: string[], msg: object) { for (const id of ids) this.send(id, msg) }
  all() { return new Map([...this.online].map((id) => [id, {} as any])) }
}

/** A minimal device row, inserted directly (stateTabs.test.ts's pattern). */
function mkDevice(db: DB, id: string): void {
  db.prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, 'd', ?, 0)")
    .run(id, `hash-${id}`)
}

/** A screen whose one cell binds `widget.config.feed` to the given feed id. */
function mkScreen(db: DB, feedId: string): { id: string } {
  return createScreen(db, {
    name: `screen-${feedId}`,
    orientation: 'landscape',
    grid: { cells: [{ widget: 'value', config: { feed: feedId }, rect: { x: 0, y: 0, w: 1, h: 1 } }] },
  }, 0)
}

function setPushedBy(db: DB, feedId: string, senderId: string): void {
  db.prepare('UPDATE feeds SET pushed_by = ? WHERE id = ?').run(senderId, feedId)
}

describe('computeTabStatus', () => {
  it('lights the screen whose feed the alerting sender pushes to (pushed_by)', () => {
    const db = openDb(':memory:')
    const dev = 'dev_1'
    mkDevice(db, dev)
    const sender = createSender(db, 'sender-a', []).sender
    const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 0)
    setPushedBy(db, feed.id, sender.id)
    const screen = mkScreen(db, feed.id)

    ingestNotify(db, {
      senderId: sender.id, title: 'hot', severity: 'warn', targetDevices: [dev],
    }, 1000)

    expect(computeTabStatus(db, [screen.id])).toEqual({ [screen.id]: 'warn' })
  })

  it('lights via allowed_senders when never pushed', () => {
    const db = openDb(':memory:')
    const dev = 'dev_1'
    mkDevice(db, dev)
    const sender = createSender(db, 'sender-a', []).sender
    const feed = createFeed(db, { name: 'cpu', mode: 'value', allowed_senders: [sender.id] }, 0)
    // Deliberately never pushed: pushed_by stays NULL.
    const screen = mkScreen(db, feed.id)

    ingestNotify(db, {
      senderId: sender.id, title: 'hot', severity: 'critical', targetDevices: [dev],
    }, 1000)

    expect(computeTabStatus(db, [screen.id])).toEqual({ [screen.id]: 'critical' })
  })

  it('picks the worst severity across senders and clears when the alert is dismissed', () => {
    const db = openDb(':memory:')
    const dev = 'dev_1'
    mkDevice(db, dev)
    const s1 = createSender(db, 'sender-1', []).sender
    const s2 = createSender(db, 'sender-2', []).sender
    const feed1 = createFeed(db, { name: 'f1', mode: 'value' }, 0)
    setPushedBy(db, feed1.id, s1.id)
    const feed2 = createFeed(db, { name: 'f2', mode: 'value', allowed_senders: [s2.id] }, 0)
    const screen = createScreen(db, {
      name: 'combined',
      orientation: 'landscape',
      grid: { cells: [
        { widget: 'value', config: { feed: feed1.id }, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        { widget: 'value', config: { feed: feed2.id }, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      ] },
    }, 0)

    const { alert: a1 } = ingestNotify(db, {
      senderId: s1.id, title: 'warn', severity: 'warn', targetDevices: [dev],
    }, 1000)
    const { alert: a2 } = ingestNotify(db, {
      senderId: s2.id, title: 'critical', severity: 'critical', targetDevices: [dev],
    }, 1000)

    expect(computeTabStatus(db, [screen.id])).toEqual({ [screen.id]: 'critical' })

    // Dismiss both underlying alerts; the screen's feeds still have alert-capable senders, so it
    // degrades to the positive all-clear rather than vanishing (monitored-and-quiet = 'ok').
    recordTap(db, a1.id, dev, 'dismiss', 2000)
    recordTap(db, a2.id, dev, 'dismiss', 2000)

    expect(computeTabStatus(db, [screen.id])).toEqual({ [screen.id]: 'ok' })
  })

  it("a monitored screen with no active alert reads 'ok'; an unmonitored one gets no entry", () => {
    const db = openDb(':memory:')
    const sender = createSender(db, 'quiet-sender', []).sender
    const monitoredFeed = createFeed(db, { name: 'monitored', mode: 'value', allowed_senders: [sender.id] }, 0)
    const orphanFeed = createFeed(db, { name: 'orphan', mode: 'value' }, 0)
    const monitored = mkScreen(db, monitoredFeed.id)
    const unmonitored = mkScreen(db, orphanFeed.id)

    expect(computeTabStatus(db, [monitored.id, unmonitored.id])).toEqual({ [monitored.id]: 'ok' })
  })

  it('an alert from a sender with no feeds lights nothing', () => {
    const db = openDb(':memory:')
    const dev = 'dev_1'
    mkDevice(db, dev)
    const sender = createSender(db, 'unattributed', []).sender
    const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 0)
    const screen = mkScreen(db, feed.id)
    // Neither pushed_by nor allowed_senders ever mention this sender.

    ingestNotify(db, {
      senderId: sender.id, title: 'noise', severity: 'critical', targetDevices: [dev],
    }, 1000)

    expect(computeTabStatus(db, [screen.id])).toEqual({})
  })

  /**
   * The same attribution `computeTabStatus` uses, asked the other way round: not "what colour is
   * this tab" but "which tabs is THIS alert colouring". A red dot with no way to ask what it meant
   * is the whole complaint the admin alerts view answers, so the two must derive it from one index
   * — a second, hand-rolled walk of feeds is how the dot and its explanation start disagreeing.
   */
  describe('screensLitBySender', () => {
    it('names the screens whose feeds the sender pushes to, or is allowed on', () => {
      const db = openDb(':memory:')
      const sender = createSender(db, 'sender-a', []).sender
      const pushed = createFeed(db, { name: 'pushed', mode: 'value' }, 0)
      setPushedBy(db, pushed.id, sender.id)
      const allowed = createFeed(db, { name: 'allowed', mode: 'value', allowed_senders: [sender.id] }, 0)
      const pushedScreen = mkScreen(db, pushed.id)
      const allowedScreen = mkScreen(db, allowed.id)

      expect(screensLitBySender(db, sender.id)).toEqual([
        { id: pushedScreen.id, name: `screen-${pushed.id}` },
        { id: allowedScreen.id, name: `screen-${allowed.id}` },
      ])
    })

    it('leaves out screens fed by other senders, and reports none for an unattributed sender', () => {
      const db = openDb(':memory:')
      const mine = createSender(db, 'mine', []).sender
      const theirs = createSender(db, 'theirs', []).sender
      const unattributed = createSender(db, 'unattributed', []).sender
      const myFeed = createFeed(db, { name: 'mine', mode: 'value' }, 0)
      setPushedBy(db, myFeed.id, mine.id)
      const theirFeed = createFeed(db, { name: 'theirs', mode: 'value' }, 0)
      setPushedBy(db, theirFeed.id, theirs.id)
      const myScreen = mkScreen(db, myFeed.id)
      mkScreen(db, theirFeed.id)

      expect(screensLitBySender(db, mine.id)).toEqual([{ id: myScreen.id, name: `screen-${myFeed.id}` }])
      expect(screensLitBySender(db, unattributed.id)).toEqual([])
    })
  })

  it('pushTabStatus sends TAB_STATUS only to online devices with >1 tab', () => {
    const db = openDb(':memory:')
    const multi = 'dev_multi'
    const single = 'dev_single'
    const offline = 'dev_offline'
    mkDevice(db, multi)
    mkDevice(db, single)
    mkDevice(db, offline)

    const sender = createSender(db, 'sender-a', []).sender
    const feed = createFeed(db, { name: 'cpu', mode: 'value' }, 0)
    setPushedBy(db, feed.id, sender.id)
    const screenA = mkScreen(db, feed.id)
    const screenB = createScreen(db, { name: 'blank', orientation: 'landscape', grid: { cells: [] } }, 0)

    setDeviceTabs(db, multi, [{ screen_id: screenA.id }, { screen_id: screenB.id }])
    setDeviceTabs(db, single, [{ screen_id: screenA.id }])
    setDeviceTabs(db, offline, [{ screen_id: screenA.id }, { screen_id: screenB.id }])

    ingestNotify(db, {
      senderId: sender.id, title: 'hot', severity: 'warn', targetDevices: [multi],
    }, 1000)

    const registry = new FakeRegistry()
    registry.online.add(multi)
    registry.online.add(single)
    // `offline` deliberately left out of `online`.

    pushTabStatus(db, registry as any)

    expect(registry.sent).toEqual([
      { deviceId: multi, msg: { type: 'TAB_STATUS', tab_status: { [screenA.id]: 'warn' } } },
    ])
  })
})
