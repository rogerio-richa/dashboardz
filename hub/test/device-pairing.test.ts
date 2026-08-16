import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// @ts-expect-error plain JS module without types
import { cleanPairCode, pairCodeProblem, pairFailureMessage } from '../static/device/device-core.mjs'
import { hasBrowser, openPage, serveStatic, type Page } from './support/browser.js'

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static')
const html = readFileSync(join(STATIC_ROOT, 'device', 'index.html'), 'utf8')
const pairing = html.slice(html.indexOf('<div id="pairing"'), html.indexOf('<div id="idle">'))

describe('pairing code checks', () => {
  it('ignores case, spaces and dashes people copy along with the code', () => {
    expect(cleanPairCode(' k7m-2qx ')).toBe('K7M2QX')
    expect(cleanPairCode(undefined)).toBe('')
  })

  it('accepts a code from the hub alphabet', () => {
    expect(pairCodeProblem('K7M2QX')).toBeNull()
  })

  it('explains a wrong length and the characters codes never use', () => {
    expect(pairCodeProblem('K7M2')).toMatch(/6 characters/)
    expect(pairCodeProblem('ABC123')).toMatch(/0, 1, I or O/)
    expect(pairCodeProblem('K7M2QO')).toMatch(/0, 1, I or O/)
  })

  it('tells a used or expired code apart from an unreachable hub', () => {
    expect(pairFailureMessage(400)).toMatch(/used already or be older than 10 minutes/)
    expect(pairFailureMessage(null)).toMatch(/Can't reach the hub/)
    expect(pairFailureMessage(500)).toMatch(/error 500/)
  })
})

describe('pair screen gives a first-time visitor somewhere to go', () => {
  it('links to the pairing guide in the docs', () => {
    expect(pairing).toContain('href="https://www.scztech.com.br/dashboardz/docs/getting-started/#3-pair-a-browser-device"')
  })

  it('links to the Android app guide', () => {
    expect(pairing).toContain('href="https://www.scztech.com.br/dashboardz/docs/android/"')
  })

  it('offers a way back to the hub front page', () => {
    expect(pairing).toMatch(/<a class="pair-back" href="\/">/)
  })

  it('points at the admin where codes are made', () => {
    expect(pairing).toContain('href="/admin"')
  })
})

const maybe = hasBrowser() ? describe : describe.skip

maybe('pair form in a browser', () => {
  let server: { url: string; close: () => void }
  let pairBodies: string[] = []
  beforeAll(async () => {
    server = await serveStatic(STATIC_ROOT, {
      '/api/pair': (req, res) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          pairBodies.push(body)
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end('{"error":"invalid or expired code"}')
        })
      },
    })
  })
  afterAll(() => server?.close())

  const submit = (page: Page, code: string) => page.evaluate(`(() => {
    document.getElementById('pair-code').value = ${JSON.stringify(code)}
    document.getElementById('pair-form').requestSubmit()
  })()`)
  const errorText = (page: Page) => page.evaluate<string>(`document.getElementById('pair-error').textContent`)

  it('catches a mistyped code without asking the hub', async () => {
    let page: Page | undefined
    pairBodies = []
    try {
      page = await openPage(`${server.url}/device/`, 853, 384)
      expect(await page.evaluate<string>('document.title')).toBe('Pair this device · Dashboardz')
      await submit(page, 'abc123')
      expect(await errorText(page)).toMatch(/0, 1, I or O/)
      expect(pairBodies).toEqual([])
    } finally {
      await page?.close()
    }
  })

  it('sends the cleaned code and explains a refusal', async () => {
    let page: Page | undefined
    pairBodies = []
    try {
      page = await openPage(`${server.url}/device/`, 853, 384)
      await submit(page, 'k7m-2qx')
      for (let i = 0; i < 50 && !(await errorText(page)); i++) await new Promise((r) => setTimeout(r, 50))
      expect(pairBodies).toEqual(['{"code":"K7M2QX"}'])
      expect(await errorText(page)).toMatch(/used already/)
      expect(await page.evaluate<boolean>(`document.getElementById('pair-submit').disabled`)).toBe(false)
    } finally {
      await page?.close()
    }
  })
})
