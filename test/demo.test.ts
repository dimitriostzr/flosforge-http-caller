import { describe, expect, it } from 'vitest'
import { buildDemo } from '@shared/demo'
import { exportCollectionV21, importText } from '@shared/importers'
import { splitUrl, parseQuery } from '@shared/url'
import type { ApiRequest, Folder, TreeItem } from '@shared/types'

const flatten = (items: TreeItem[]): ApiRequest[] =>
  items.flatMap((i) => (i.kind === 'request' ? [i] : flatten(i.items)))

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => unknown

describe('demo workspace content', () => {
  const { collection, environment } = buildDemo()
  const requests = flatten(collection.items)

  it('has six folders of requests', () => {
    expect(collection.items.map((i) => i.kind)).toEqual(Array(6).fill('folder'))
    expect(requests.length).toBeGreaterThan(30)
  })

  it('gives every item a unique id', () => {
    const ids = [collection.id, ...collection.items.flatMap((f) => [f.id, ...(f as Folder).items.map((r) => r.id)])]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('compiles every script', () => {
    const scripts = [collection.scripts, ...requests.map((r) => r.scripts)].flatMap((s) => [s.preRequest, s.test]).filter(Boolean)
    expect(scripts.length).toBeGreaterThan(20)
    for (const code of scripts) expect(() => new AsyncFunction('pm', 'console', 'CryptoJS', code), code).not.toThrow()
  })

  it('keeps URLs and params in sync', () => {
    for (const r of requests) {
      const enabled = r.params.filter((p) => p.enabled).map(({ key, value }) => ({ key, value }))
      expect(parseQuery(splitUrl(r.url).query), r.name).toEqual(enabled)
    }
  })

  it('only references variables that exist (or are set by a script first)', () => {
    const defined = new Set([...environment.variables, ...collection.variables].map((v) => v.key))
    const setByScripts = new Set(['randomId', 'requestId', 'userEmail'])
    const texts = requests.flatMap((r) => [
      r.url,
      r.body.raw,
      r.body.graphql.variables,
      ...r.headers.map((h) => h.value),
      r.auth.bearer?.token ?? '',
      r.auth.apikey?.value ?? ''
    ])
    for (const f of collection.items as Folder[]) texts.push(f.auth.bearer?.token ?? '')
    for (const t of texts)
      for (const [, name] of t.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g))
        if (!name.startsWith('$')) expect(defined.has(name) || setByScripts.has(name), `{{${name}}}`).toBe(true)
  })

  it('survives a v2.1 export and re-import', () => {
    const back = importText(JSON.stringify(exportCollectionV21(collection))).collections[0]
    expect(flatten(back.items).map((r) => [r.name, r.method, r.url, r.body.mode, r.auth.type])).toEqual(
      requests.map((r) => [r.name, r.method, r.url, r.body.mode, r.auth.type])
    )
  })
})
