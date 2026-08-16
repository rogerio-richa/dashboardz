import { describe, expect, it } from 'vitest'
import { parseRssItems } from '../src/sources/providers/rssItems.js'

/**
 * The RSS/Atom reader, on its own.
 *
 * Fetching is not its job — `sources/errors.ts` owns the capped, deadlined, redacted HTTP boundary
 * every provider shares, and the RSS provider hands the body straight here. Nor is capping or
 * ordering: this returns items in PUBLISHER order (newest first), and `providers/rss.ts` owns the
 * dedupe, the cap and the reversal a stream feed needs, with its own coverage in
 * `providerRss.test.ts`. What is left here is the XML the real world actually serves.
 */
const rows = (xml: string): Record<string, unknown>[] => parseRssItems(xml)

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>Newest post</title>
    <link>https://example.test/3</link>
    <guid isPermaLink="false">tag:example,2026:3</guid>
    <pubDate>Wed, 05 Aug 2026 10:00:00 GMT</pubDate>
    <description>The third one.</description>
  </item>
  <item>
    <title>Middle post</title>
    <link>https://example.test/2</link>
    <pubDate>Tue, 04 Aug 2026 10:00:00 GMT</pubDate>
    <description>The second one.</description>
  </item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <entry>
    <title>Atom post</title>
    <link rel="alternate" type="text/html" href="https://example.test/a1"/>
    <id>urn:uuid:1</id>
    <published>2026-08-05T09:00:00Z</published>
    <summary>An atom summary.</summary>
  </entry>
</feed>`

describe('the RSS and Atom reader', () => {
  it('reads RSS 2.0 items into the declared row shape', () => {
    const res = rows(RSS2)
    expect(res).toContainEqual({
      title: 'Newest post',
      link: 'https://example.test/3',
      published_at: Date.parse('2026-08-05T10:00:00Z'),
      summary: 'The third one.',
    })
  })

  /**
   * Publisher order, kept. A stream feed reads newest-LAST, so somebody has to reverse this — but
   * that somebody is the provider, which also has to dedupe and cap first. Reversing here would
   * mean capping the wrong end of the document.
   */
  it('emits newest first, exactly as the publisher wrote it', () => {
    const res = rows(RSS2)
    expect(res.map((r) => r.title)).toEqual(['Newest post', 'Middle post'])
  })

  it('reads Atom entries too', () => {
    const res = rows(ATOM)
    expect(res).toEqual([{
      title: 'Atom post',
      link: 'https://example.test/a1',
      published_at: Date.parse('2026-08-05T09:00:00Z'),
      summary: 'An atom summary.',
    }])
  })

  describe('the XML the real world actually serves', () => {
    it('unwraps CDATA', () => {
      const res = rows(`<rss><channel><item>
        <title><![CDATA[Bread & butter <prices>]]></title>
        <link>https://example.test/1</link>
        <description><![CDATA[<p>Rich <b>text</b> here.</p>]]></description>
      </item></channel></rss>`)
      expect(res[0].title).toBe('Bread & butter <prices>')
      // A board draws text, not markup — tags out, words kept.
      expect(res[0].summary).toBe('Rich text here.')
    })

    it('decodes entities', () => {
      const res = rows(`<rss><channel><item>
        <title>Q&amp;A: what&#39;s next &lt;really&gt;</title>
        <link>https://example.test/1</link>
      </item></channel></rss>`)
      expect(res[0].title).toBe("Q&A: what's next <really>")
    })

    it('strips HTML out of a description and collapses whitespace', () => {
      const res = rows(`<rss><channel><item>
        <title>T</title><link>https://example.test/1</link>
        <description>&lt;p&gt;One   two&lt;/p&gt;

        &lt;p&gt;three&lt;/p&gt;</description>
      </item></channel></rss>`)
      expect(res[0].summary).toBe('One two three')
    })

    /** A namespaced feed (Dublin Core, media:*) must not confuse the tag matching. */
    it('is not fooled by namespaced siblings', () => {
      const res = rows(`<rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
        <dc:title>WRONG</dc:title>
        <title>Right</title>
        <link>https://example.test/1</link>
        <media:title>ALSO WRONG</media:title>
      </item></channel></rss>`)
      expect(res[0].title).toBe('Right')
    })

    /**
     * Identity is what dedupe rests on, and plenty of feeds carry a guid and no link at all. The
     * guid stands in so the row still has something stable to be recognised by — without it, every
     * poll would re-append the whole feed.
     */
    it('falls back to the guid when there is no link', () => {
      const res = rows(`<rss><channel><item>
        <title>Linkless</title><guid>tag:example,2026:9</guid>
      </item></channel></rss>`)
      expect(res[0].link).toBe('tag:example,2026:9')
    })

    it('skips an item with no identity at all rather than duplicating it forever', () => {
      const res = rows(`<rss><channel>
        <item><title>No id</title></item>
        <item><title>Fine</title><link>https://example.test/1</link></item>
      </channel></rss>`)
      expect(res.map((r) => r.title)).toEqual(['Fine'])
    })

    it('leaves published_at null when the date is missing or unreadable', () => {
      const res = rows(`<rss><channel><item>
        <title>T</title><link>https://example.test/1</link><pubDate>last Thursday</pubDate>
      </item></channel></rss>`)
      expect(res[0].published_at).toBeNull()
    })

    it('titles an item that has none', () => {
      const res = rows(`<rss><channel><item><link>https://example.test/1</link></item></channel></rss>`)
      expect(res[0].title).toBe('(untitled)')
    })
  })

  it('reports a body that is not a feed', () => {
    expect(() => rows('<html>Hello</html>')).toThrow(/feed/i)
  })

  it('accepts a feed that is simply empty today', () => {
    const res = rows('<rss version="2.0"><channel><title>Quiet</title></channel></rss>')
    expect(res).toEqual([])
  })
})
