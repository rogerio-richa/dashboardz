import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECT_MIN, RECT_QUANTUM } from '../src/screens/cellSchema.js'

const SKILL = readFileSync('../clients/mcp/SKILL.md', 'utf8')
const TOOLS_SRC = readFileSync('../clients/mcp/src/tools.ts', 'utf8')
const OPENCLAW = readFileSync('../clients/openclaw/SKILL.md', 'utf8')
const ASK = readFileSync('../integrations/claude/SKILL.md', 'utf8')

describe('the MCP skill stays true (integration boundary)', () => {
  it('names every tool the MCP actually ships', () => {
    const names = [...TOOLS_SRC.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThanOrEqual(13)
    for (const name of names) expect(SKILL, `SKILL.md must mention ${name}`).toContain(name!)
  })
  it('states the token precedence with the exact idiom the sender skill uses', () => {
    const idiom = '${DASHBOARDZ_TOKEN:-$(cat ~/.config/dashboardz/token)}'
    expect(OPENCLAW).toContain(idiom)   // if openclaw changes its rule, this skill must follow
    expect(SKILL).toContain(idiom)
  })
  it('carries the load-bearing sentences', () => {
    expect(SKILL).toMatch(/re-read.+never.+retry|never blindly retry/i)       // rev/409
    expect(SKILL).toMatch(/replaces the WHOLE grid/i)
    expect(SKILL).toMatch(/npm run build.+hub\/admin/)
    expect(SKILL).toMatch(/check_fit before binding/i)
    expect(SKILL).toMatch(/warnings/)
    expect(SKILL).toMatch(/headless browser|Playwright/)
    expect(SKILL).toMatch(/bind-mount|--build/)
  })
  it('does not restate the numbers the contract serves — one home', () => {
    // The skill may say "the contract carries the rect rules"; it must not hardcode them.
    expect(SKILL).not.toContain(String(RECT_MIN))
    expect(SKILL).not.toContain(String(RECT_QUANTUM))
  })
})

describe('the LAN ask skill stays true', () => {
  const ANSWER_ROUTE_SRC = readFileSync('src/routes/notify.ts', 'utf8')

  it('names the two routes the loop actually runs on', () => {
    expect(ASK).toContain('/api/notify')
    expect(ASK).toContain('/api/alerts/<alert-id>/answer')
    expect(ANSWER_ROUTE_SRC).toContain("'/api/alerts/:id/answer'")
  })
  it('documents exactly the four states alertAnswerForSender can return', () => {
    // The AlertAnswerView union in db/alerts.ts is the authority; the skill must list all of
    // them and invent none — a fifth state in the doc is a promise the hub does not keep.
    for (const state of ['pending', 'answered', 'dismissed', 'expired']) {
      expect(ASK, `skill must document state "${state}"`).toContain(`"state":"${state}"`)
    }
  })
  it('keeps the token-hygiene rule the sender skill established', () => {
    expect(ASK).toContain('~/.config/dashboardz/')
    expect(ASK).toMatch(/never hunt for tokens/i)
  })
  it('carries the severity discipline the hub enforces', () => {
    // resolveSound: info can never be audible; critical never expires. The skill must not
    // teach anything softer.
    // \s+ because prose wraps: "never\n  audible" is the same sentence to a reader.
    expect(ASK).toMatch(/never\s+audible/i)
    expect(ASK).toMatch(/never\s+expires/i)
  })
})
