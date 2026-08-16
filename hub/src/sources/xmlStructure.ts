export type XmlContent =
  | { kind: 'text'; value: string; cdata: boolean }
  | { kind: 'element'; index: number }

export interface XmlAttribute {
  name: string
  value: string
}

export interface XmlElement {
  name: string
  attributes: readonly XmlAttribute[]
  parent: number | null
  start: number
  content_start: number
  content_end: number
  end: number
  opening: string
  content: readonly XmlContent[]
}

export interface XmlStructure {
  root: string
  root_index: number
  root_children: ReadonlySet<string>
  elements: readonly XmlElement[]
}

type MutableXmlElement = Omit<XmlElement, 'content'> & { content: XmlContent[] }

const whitespace = (char: string): boolean => /\s/.test(char)
const nameStart = (char: string): boolean => /[A-Za-z_:]/.test(char) || char.charCodeAt(0) >= 0x80
const nameChar = (char: string): boolean => /[A-Za-z0-9_.:-]/.test(char) || char.charCodeAt(0) >= 0x80

function readName(xml: string, start: number): { name: string; next: number } | null {
  if (start >= xml.length || !nameStart(xml[start])) return null
  let next = start + 1
  while (next < xml.length && nameChar(xml[next])) next++
  return { name: xml.slice(start, next), next }
}

function skipDelimited(xml: string, start: number, end: string): number | null {
  const found = xml.indexOf(end, start)
  return found < 0 ? null : found + end.length
}

/** Skip a complete doctype, including quotes and an optional internal subset. */
function skipDoctype(xml: string, start: number): number | null {
  let quote: '"' | "'" | null = null
  let subsetDepth = 0
  for (let index = start; index < xml.length; index++) {
    const char = xml[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (xml.startsWith('<!--', index)) {
      const next = skipDelimited(xml, index + 4, '-->')
      if (next === null) return null
      index = next - 1
      continue
    }
    if (xml.startsWith('<?', index)) {
      const next = skipDelimited(xml, index + 2, '?>')
      if (next === null) return null
      index = next - 1
      continue
    }
    if (char === '[') subsetDepth++
    else if (char === ']') {
      if (subsetDepth === 0) return null
      subsetDepth--
    } else if (char === '>' && subsetDepth === 0) return index + 1
  }
  return null
}

function readStartTag(
  xml: string,
  start: number,
): { name: string; attributes: XmlAttribute[]; next: number; selfClosing: boolean } | null {
  const named = readName(xml, start)
  if (named === null) return null
  const attributes: XmlAttribute[] = []
  let index = named.next
  while (index < xml.length) {
    if (xml[index] === '>') return { name: named.name, attributes, next: index + 1, selfClosing: false }
    if (xml[index] === '/') {
      index++
      while (index < xml.length && whitespace(xml[index])) index++
      return xml[index] === '>'
        ? { name: named.name, attributes, next: index + 1, selfClosing: true }
        : null
    }
    if (!whitespace(xml[index])) return null
    while (index < xml.length && whitespace(xml[index])) index++
    if (xml[index] === '>' || xml[index] === '/') continue

    const attribute = readName(xml, index)
    if (attribute === null) return null
    index = attribute.next
    while (index < xml.length && whitespace(xml[index])) index++
    if (xml[index] !== '=') return null
    index++
    while (index < xml.length && whitespace(xml[index])) index++
    const quote = xml[index]
    if (quote !== '"' && quote !== "'") return null
    const valueStart = ++index
    while (index < xml.length && xml[index] !== quote) {
      if (xml[index] === '<') return null
      index++
    }
    if (index >= xml.length) return null
    attributes.push({ name: attribute.name, value: xml.slice(valueStart, index) })
    index++
  }
  return null
}

function readEndTag(xml: string, start: number): { name: string; next: number } | null {
  const named = readName(xml, start)
  if (named === null) return null
  let next = named.next
  while (next < xml.length && whitespace(xml[next])) next++
  return xml[next] === '>' ? { name: named.name, next: next + 1 } : null
}

/**
 * A bounded, non-recursive XML structural pass. It balances every element QName while treating
 * complete declarations, processing instructions, comments, CDATA, and doctypes as opaque.
 */
export function scanXmlStructure(xml: string): XmlStructure | null {
  const stack: number[] = []
  const rootChildren = new Set<string>()
  const elements: MutableXmlElement[] = []
  let root: string | null = null
  let rootIndex: number | null = null
  let rootClosed = false
  let seenDoctype = false
  let index = 0

  while (index < xml.length) {
    if (xml[index] !== '<') {
      const next = xml.indexOf('<', index)
      const end = next < 0 ? xml.length : next
      if (stack.length === 0 && xml.slice(index, end).trim() !== '') return null
      if (stack.length > 0) {
        elements[stack.at(-1)!].content.push({ kind: 'text', value: xml.slice(index, end), cdata: false })
      }
      index = end
      continue
    }
    if (xml.startsWith('<!--', index)) {
      const next = skipDelimited(xml, index + 4, '-->')
      if (next === null) return null
      index = next
      continue
    }
    if (xml.startsWith('<![CDATA[', index)) {
      if (stack.length === 0) return null
      const next = skipDelimited(xml, index + 9, ']]>')
      if (next === null) return null
      elements[stack.at(-1)!].content.push({
        kind: 'text', value: xml.slice(index + 9, next - 3), cdata: true,
      })
      index = next
      continue
    }
    if (xml.startsWith('<?', index)) {
      const next = skipDelimited(xml, index + 2, '?>')
      if (next === null) return null
      index = next
      continue
    }
    if (xml.startsWith('<!DOCTYPE', index)) {
      if (stack.length !== 0 || root !== null || seenDoctype) return null
      const next = skipDoctype(xml, index + 9)
      if (next === null) return null
      seenDoctype = true
      index = next
      continue
    }
    if (xml.startsWith('<!', index)) return null
    if (xml.startsWith('</', index)) {
      const tag = readEndTag(xml, index + 2)
      const elementIndex = stack.pop()
      if (tag === null || elementIndex === undefined || elements[elementIndex].name !== tag.name) return null
      elements[elementIndex].content_end = index
      elements[elementIndex].end = tag.next
      if (stack.length === 0) rootClosed = true
      index = tag.next
      continue
    }

    const tag = readStartTag(xml, index + 1)
    if (tag === null || rootClosed) return null
    const parent = stack.at(-1) ?? null
    const elementIndex = elements.length
    elements.push({
      name: tag.name,
      attributes: tag.attributes,
      parent,
      start: index,
      content_start: tag.next,
      content_end: tag.next,
      end: tag.next,
      opening: xml.slice(index, tag.next),
      content: [],
    })
    if (parent !== null) elements[parent].content.push({ kind: 'element', index: elementIndex })
    if (stack.length === 0) {
      if (root !== null) return null
      root = tag.name
      rootIndex = elementIndex
    } else if (stack.length === 1) {
      rootChildren.add(tag.name)
    }
    if (tag.selfClosing) {
      if (stack.length === 0) rootClosed = true
    } else {
      stack.push(elementIndex)
    }
    index = tag.next
  }

  return root !== null && rootIndex !== null && rootClosed && stack.length === 0
    ? { root, root_index: rootIndex, root_children: rootChildren, elements }
    : null
}
