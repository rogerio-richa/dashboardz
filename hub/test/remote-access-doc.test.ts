import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('remote-access docs page', () => {
  it('exists, is in the mkdocs nav, and is linked from the README', () => {
    expect(read('../../docs/remote-access.md')).toContain('# Remote access')
    expect(read('../../mkdocs.yml')).toContain('- Remote access: remote-access.md')
    expect(read('../../README.md')).toContain('dashboardz/docs/remote-access/')
  })

  it('the admin badge links to the page the site actually serves', () => {
    const site = read('../../mkdocs.yml').match(/^site_url:\s*(\S+)/m)![1]
    expect(read('../admin/src/RelayBadge.tsx')).toContain(`${site}remote-access/`)
  })

  it('makes no pricing or SLA promises (standing rule)', () => {
    expect(read('../../docs/remote-access.md')).not.toMatch(/\$\d|per month|pricing|SLA|uptime guarantee/i)
  })
})
