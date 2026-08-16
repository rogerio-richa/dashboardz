import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateContractOutput } from '../src/data/contracts.js'
import { rssProvider } from '../src/sources/providers/rss.js'

const XML = readFileSync(new URL('./fixtures/rss-news.xml', import.meta.url), 'utf8')
const NOW = Date.parse('2026-08-05T12:00:00Z')
const context = (body: string, status = 200) => ({
  fetch: (async () => new Response(body, { status })) as typeof fetch,
  now: NOW,
  signal: new AbortController().signal,
})

describe('RSS provider', () => {
  const input = { config: { max_items: 20 }, secrets: { url: 'https://news.example.test/private.xml' } }

  it('keeps the URL secret and caps normalized setup at the contract limit', () => {
    expect(rssProvider.validateSetup({ max_items: 999 }, input.secrets)).toEqual({
      ok: true,
      config: { max_items: 100 },
      secrets: { url: 'https://news.example.test/private.xml' },
    })
    expect(rssProvider.validateSetup({}, {})).toMatchObject({ ok: false })
  })

  it('reuses RSS parsing while emitting stable canonical ids and the compatibility link alias', async () => {
    const [output] = await rssProvider.run(input, context(XML))

    expect(output.contract_id).toBe('dashboardz.news.items/v1')
    expect(output.result).toEqual({
      mode: 'stream',
      dedupe_by: 'id',
      rows: [
        {
          id: 'story-two', title: 'Guid only', summary: 'The second story.',
          url: 'story-two', link: 'story-two', published_at: Date.parse('2026-08-04T10:00:00Z'),
        },
        {
          id: 'https://news.example.test/three', title: 'Newest & brightest', summary: 'The third story.',
          url: 'https://news.example.test/three', link: 'https://news.example.test/three',
          published_at: Date.parse('2026-08-05T10:00:00Z'),
        },
      ],
    })
    expect(validateContractOutput(output.contract_id, output.result).ok).toBe(true)
  })

  it('keeps the newest duplicate identity and caps only after finding distinct items', async () => {
    const xml = `<rss><channel>
      <item><title>Newest A</title><link>https://example.test/a</link></item>
      <item><title>Newest B</title><link>https://example.test/b</link></item>
      <item><title>Older A</title><link>https://example.test/a</link></item>
      <item><title>Newest C</title><link>https://example.test/c</link></item>
    </channel></rss>`
    const [output] = await rssProvider.run(
      { config: { max_items: 3 }, secrets: input.secrets },
      context(xml),
    )

    expect((output.result as any).rows.map((row: Record<string, unknown>) => row.title)).toEqual([
      'Newest C', 'Newest B', 'Newest A',
    ])
  })

  it('does not reveal the secret URL in HTTP or parsing errors', async () => {
    for (const ctx of [context('unauthorized private body', 401), context('<html>private login</html>')]) {
      const error = await rssProvider.run(input, ctx).catch((caught) => caught)
      expect(error.message).not.toContain(input.secrets.url)
      expect(error.message).not.toContain('private')
    }
  })

  it('rejects a structurally truncated feed instead of returning its complete-looking prefix', async () => {
    const truncated = `<rss><channel>
      <item><title>Prefix story</title><link>https://example.test/prefix</link></item>`

    await expect(rssProvider.run(input, context(truncated))).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects misnested structural feed tags even when their counts balance', async () => {
    const misnested = `<rss><channel><item>
      <title>Misnested</title><link>https://example.test/misnested</link>
      </channel></item></rss>`

    await expect(rssProvider.run(input, context(misnested))).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('rejects an unclosed arbitrary child tag inside an otherwise complete feed envelope', async () => {
    const malformed = `<rss><channel><item>
      <title>Never closed<link>https://example.test/unclosed</link>
      </item></channel></rss>`

    await expect(rssProvider.run(input, context(malformed))).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('accepts an Atom feed after an XML stylesheet processing instruction', async () => {
    const xml = `<?xml version="1.0"?>
      <?xml-stylesheet type="text/xsl" href="/feed.xsl"?>
      <feed xmlns="http://www.w3.org/2005/Atom"><entry>
        <title>Styled Atom</title><link href="https://example.test/styled"/>
      </entry></feed>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0].title).toBe('Styled Atom')
  })

  it('ignores href-shaped text inside an Atom link attribute and falls back to the entry id', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Stable identity</title>
      <link title = 'annotation href = "https://ghost.example.test/story"' />
      <id>tag:example.test,2026:stable</id>
    </entry></feed>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0]).toMatchObject({
      id: 'tag:example.test,2026:stable',
      url: 'tag:example.test,2026:stable',
      link: 'tag:example.test,2026:stable',
    })
  })

  it('ignores rel-shaped text inside an Atom link attribute when selecting the story link', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Correct link</title>
      <link title='annotation rel = "alternate"' rel = "self" href = "https://example.test/feed/entry" />
      <link href = 'https://example.test/story?from=atom&amp;edition=morning' />
      <id>tag:example.test,2026:correct-link</id>
    </entry></feed>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0]).toMatchObject({
      id: 'https://example.test/story?from=atom&edition=morning',
      url: 'https://example.test/story?from=atom&edition=morning',
      link: 'https://example.test/story?from=atom&edition=morning',
    })
  })

  it('accepts RSS after a complete internal-subset doctype', async () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE rss [
        <!ELEMENT rss ANY>
        <!ENTITY publisher "Example News">
      ]>
      <rss><channel><item>
        <title>Internal subset</title><link>https://example.test/subset</link>
      </item></channel></rss>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0].title).toBe('Internal subset')
  })

  it.each([
    [
      'comment',
      `<rss><channel>
        <!-- <item><title>Comment ghost</title><link>https://example.test/comment-ghost</link></item> -->
        <item><title>Real story</title><link>https://example.test/real</link></item>
      </channel></rss>`,
    ],
    [
      'CDATA',
      `<rss><channel>
        <![CDATA[<item><title>CDATA ghost</title><link>https://example.test/cdata-ghost</link></item>]]>
        <item><title>Real story</title><link>https://example.test/real</link></item>
      </channel></rss>`,
    ],
    [
      'processing instruction',
      `<rss><channel>
        <?ghost <item><title>PI ghost</title><link>https://example.test/pi-ghost</link></item> ?>
        <item><title>Real story</title><link>https://example.test/real</link></item>
      </channel></rss>`,
    ],
    [
      'internal-subset doctype',
      `<!DOCTYPE rss [
        <!ENTITY ghost "<item><title>DOCTYPE ghost</title><link>https://example.test/doctype-ghost</link></item>">
      ]>
      <rss><channel>
        <item><title>Real story</title><link>https://example.test/real</link></item>
      </channel></rss>`,
    ],
  ])('ignores item-shaped text inside a valid %s', async (_case, xml) => {
    const [output] = await rssProvider.run(input, context(xml))

    expect((output.result as any).rows.map((row: Record<string, unknown>) => row.title)).toEqual(['Real story'])
  })

  it('does not let an opaque ghost displace a genuine item under max_items', async () => {
    const xml = `<!DOCTYPE rss [
      <!ENTITY ghost "<item><title>Cap ghost</title><link>https://example.test/cap-ghost</link></item>">
    ]>
    <rss><channel>
      <item><title>Newest real</title><link>https://example.test/newest-real</link></item>
      <item><title>Older real</title><link>https://example.test/older-real</link></item>
    </channel></rss>`

    const [output] = await rssProvider.run(
      { config: { max_items: 1 }, secrets: input.secrets },
      context(xml),
    )
    expect((output.result as any).rows.map((row: Record<string, unknown>) => row.title)).toEqual(['Newest real'])
  })

  it('preserves markup-shaped CDATA as genuine field text without treating it as an element', async () => {
    const xml = `<rss><channel><item>
      <title><![CDATA[Literal <item> headline]]></title>
      <link>https://example.test/cdata-title</link>
    </item></channel></rss>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0].title).toBe('Literal <item> headline')
  })

  it('accepts a complete RSS document with a doctype declaration', async () => {
    const xml = `<!DOCTYPE rss PUBLIC "-//RSS Advisory Board//DTD RSS 2.0//EN" "https://example.test/rss.dtd">
      <rss><channel><item><title>Declared</title><link>https://example.test/declared</link></item></channel></rss>`

    const [output] = await rssProvider.run(input, context(xml))
    expect((output.result as any).rows[0].title).toBe('Declared')
  })

  it('rejects oversized and malformed feeds as invalid responses', async () => {
    for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), '<html>not a feed</html>']) {
      await expect(rssProvider.run(input, context(body))).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
})
