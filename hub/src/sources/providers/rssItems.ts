import {
  scanXmlStructure, type XmlContent, type XmlStructure,
} from '../xmlStructure.js'

/**
 * RSS 2.0 and Atom, into the rows the news contract is built from.
 *
 * Hand-rolled rather than built on an XML parser, and that is a deliberate trade rather than a
 * shortcut. What this needs is shallow: find the item blocks, pull six known child tags out of
 * each. The candidate dependency (fast-xml-parser) is 1.3MB across six transitive packages to do
 * that — where node-ical's weight buys RFC 5545 recurrence, which genuinely cannot be hand-rolled,
 * this would buy tag matching. The parts that actually bite — CDATA, entities, namespaced siblings,
 * markup inside descriptions — are handled explicitly below and pinned by tests.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

const decodeEntities = (s: string): string =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })

/**
 * A board draws text, not markup. Descriptions routinely carry entity-escaped HTML, so this runs
 * AFTER entity decoding — otherwise `&lt;p&gt;` survives as literal angle brackets on the wall.
 */
const stripHtml = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const directChildren = (structure: XmlStructure, parent: number, name: string): number[] =>
  structure.elements[parent].content.flatMap((part) =>
    part.kind === 'element' && structure.elements[part.index].name.toLowerCase() === name
      ? [part.index]
      : [])

const firstChild = (structure: XmlStructure, parent: number, ...names: string[]): number | null => {
  for (const name of names) {
    const found = directChildren(structure, parent, name)[0]
    if (found !== undefined) return found
  }
  return null
}

/** Genuine descendant text in document order. Opaque constructs never enter element content. */
const elementText = (structure: XmlStructure, element: number): string => {
  const parts: string[] = []
  const pending: Array<XmlContent | ' '> = [...structure.elements[element].content].reverse()
  while (pending.length > 0) {
    const part = pending.pop()!
    if (part === ' ') {
      parts.push(part)
    } else if (part.kind === 'text') {
      parts.push(part.cdata ? part.value : decodeEntities(part.value))
    } else {
      parts.push(' ')
      pending.push(' ')
      const child = structure.elements[part.index].content
      for (let index = child.length - 1; index >= 0; index--) pending.push(child[index])
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}

const clean = (structure: XmlStructure, element: number | null): string =>
  element === null ? '' : elementText(structure, element)

const attribute = (structure: XmlStructure, element: number, name: string): string | null => {
  const found = structure.elements[element].attributes.find(
    (candidate) => candidate.name.toLowerCase() === name,
  )
  return found === undefined ? null : decodeEntities(found.value)
}

/** Atom's link is an ATTRIBUTE, and a feed may carry several — `alternate` is the human one. */
const atomLink = (structure: XmlStructure, item: number): string | null => {
  const links = directChildren(structure, item, 'link')
  const pick = links.find((index) => attribute(structure, index, 'rel')?.toLowerCase() === 'alternate')
    ?? links.find((index) => attribute(structure, index, 'rel') === null)
  return pick === undefined ? null : attribute(structure, pick, 'href')
}

const asMillis = (structure: XmlStructure, element: number | null): number | null => {
  const text = clean(structure, element)
  if (!text) return null
  const t = Date.parse(text)
  return Number.isFinite(t) ? t : null
}

const feedStructure = (body: string): XmlStructure | null => {
  const structure = scanXmlStructure(body)
  if (structure === null) return null
  const root = structure.root.toLowerCase()
  return root === 'feed' || (root === 'rss' && directChildren(structure, structure.root_index, 'channel').length > 0)
    ? structure
    : null
}

/** Parse in publisher (newest-first) order; callers own capping and storage-order reversal. */
export const parseRssItems = (body: string): Record<string, unknown>[] => {
  const structure = feedStructure(body)
  if (structure === null) throw new Error('that URL returned a structurally incomplete feed')
  const root = structure.root_index
  const itemParent = structure.root.toLowerCase() === 'rss'
    ? directChildren(structure, root, 'channel')[0]
    : root
  const items = directChildren(structure, itemParent, structure.root.toLowerCase() === 'rss' ? 'item' : 'entry')

  const rows: Record<string, unknown>[] = []
  for (const item of items) {
    /**
     * Identity, in preference order: the item's link, then its guid/id. Plenty of feeds publish a
     * guid and no link at all, and a row with NEITHER cannot be recognised on the next poll — so it
     * would be re-appended every fifteen minutes forever. Dropped instead.
     */
    const link = clean(structure, firstChild(structure, item, 'link')) || atomLink(structure, item) ||
      clean(structure, firstChild(structure, item, 'guid')) || clean(structure, firstChild(structure, item, 'id'))
    if (!link) continue

    const summary = clean(structure, firstChild(structure, item, 'description', 'summary', 'content'))
    rows.push({
      title: clean(structure, firstChild(structure, item, 'title')) || '(untitled)',
      link,
      published_at: asMillis(structure, firstChild(structure, item, 'pubdate', 'published', 'updated')),
      summary: stripHtml(summary),
    })
  }

  return rows
}
