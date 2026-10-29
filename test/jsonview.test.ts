import { describe, expect, it } from 'vitest'
import { kv, newRequest } from '@shared/model'
import { accessor, bestTablePath, compareCells, getAt, pathLabel, preview, tableFor, VALUE_COLUMN } from '@renderer/lib/jsonView'
import { missingVariables } from '@shared/engine/prepare'
import { emptyScopes, type Scopes } from '@shared/engine/variables'

describe('json view helpers', () => {
  it('builds script accessors that are valid JavaScript', () => {
    expect(accessor([])).toBe('pm.response.json()')
    expect(accessor(['data', 0, 'first-name', 'id'])).toBe('pm.response.json().data[0]["first-name"].id')
    expect(pathLabel(['data', 2, 'name'])).toBe('data[2].name')
    expect(pathLabel([])).toBe('(root)')
  })

  it('reads values at a path', () => {
    const doc = { a: [{ b: 1 }, { b: 2 }] }
    expect(getAt(doc, ['a', 1, 'b'])).toBe(2)
    expect(getAt(doc, ['a', 5, 'b'])).toBeUndefined()
    expect(getAt(doc, ['a', 0, 'b', 'c'])).toBeUndefined()
  })

  it('previews containers by size', () => {
    expect(preview([1, 2, 3])).toBe('[ 3 items ]')
    expect(preview({ a: 1 })).toBe('{ 1 key }')
    expect(preview('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })

  it('turns an array of objects into rows with the union of keys', () => {
    const t = tableFor([{ id: 1, name: 'a' }, { id: 2, extra: true }])
    expect(t.kind).toBe('rows')
    expect(t.columns).toEqual(['id', 'name', 'extra'])
    expect(t.rows[1]).toEqual({ key: 1, cells: { id: 2, extra: true } })
  })

  it('shows primitive arrays and objects in a value column', () => {
    expect(tableFor([1, 'two']).columns).toEqual([VALUE_COLUMN])
    const entries = tableFor({ a: 1, b: { c: 2 } })
    expect(entries.kind).toBe('entries')
    expect(entries.rows.map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('opens tables on the most useful array', () => {
    expect(bestTablePath([1, 2])).toEqual([])
    expect(bestTablePath({ meta: { page: 1 }, data: [1, 2, 3], tags: ['x'] })).toEqual(['data'])
    expect(bestTablePath({ result: { items: [{}, {}] } })).toEqual(['result', 'items'])
    expect(bestTablePath({ a: 1 })).toEqual([])
  })

  it('sorts numbers numerically and empties last', () => {
    const vals = [10, 9, undefined, 100]
    expect([...vals].sort(compareCells)).toEqual([9, 10, 100, undefined])
    expect(['item10', 'item9'].sort(compareCells)).toEqual(['item9', 'item10'])
  })
})

describe('missingVariables', () => {
  const scopes = (environment: Record<string, string>): Scopes => ({ ...emptyScopes(), environment })

  it('lists undefined variables in order, once each', () => {
    const req = newRequest({
      url: '{{base}}/users/{{id}}?q={{id}}',
      headers: [kv('X-Key', '{{apiKey}}'), { ...kv('X-Off', '{{disabled}}'), enabled: false }]
    })
    expect(missingVariables(req, { type: 'none' }, scopes({ base: 'https://x' }))).toEqual(['id', 'apiKey'])
  })

  it('follows nested references and ignores dynamic variables', () => {
    const req = newRequest({ url: '{{base}}/{{$guid}}' })
    expect(missingVariables(req, { type: 'none' }, scopes({ base: 'https://{{host}}' }))).toEqual(['host'])
  })

  it('checks the body and the effective auth', () => {
    const req = newRequest({ url: 'x' })
    req.body.mode = 'raw'
    req.body.raw = '{"a": "{{fromBody}}"}'
    const auth = { type: 'bearer' as const, bearer: { token: '{{token}}' } }
    expect(missingVariables(req, auth, scopes({}))).toEqual(['fromBody', 'token'])
    expect(missingVariables(req, auth, scopes({ fromBody: '1', token: 't' }))).toEqual([])
  })
})
