import { describe, expect, it } from 'vitest'
import { kv, newCollection, newRequest } from '@shared/model'
import { applyPathVariables, pathVariableNames, pathVariablesFromUrl } from '@shared/url'
import { missingVariables, prepareRequest } from '@shared/engine/prepare'
import { emptyScopes } from '@shared/engine/variables'
import { exportCollectionV21, importText } from '@shared/importers'
import { parseSse } from '@shared/sse'

describe('path variables', () => {
  it('finds :name segments in the path only', () => {
    expect(pathVariableNames('{{baseUrl}}/users/:id/posts/:postId?x=:no#:no')).toEqual(['id', 'postId'])
    expect(pathVariableNames('http://localhost:8080/a/:id')).toEqual(['id'])
    expect(pathVariableNames('localhost:8080/a')).toEqual([])
    expect(pathVariableNames('http://[::1]:80/:v')).toEqual(['v'])
    expect(pathVariableNames('https://x.test/v1/projects/p:batchGet')).toEqual([])
    expect(pathVariableNames('https://x.test/:id/:id')).toEqual(['id'])
    expect(pathVariableNames('https://x.test/:{{dyn}}')).toEqual([])
  })

  it('keeps values of names still in the URL', () => {
    const before = [kv('id', '42', true, 'the user'), kv('gone', 'x')]
    const after = pathVariablesFromUrl('/users/:id/:new', before)
    expect(after.map((v) => [v.key, v.value, v.description])).toEqual([
      ['id', '42', 'the user'],
      ['new', '', undefined]
    ])
    expect(after[0].id).toBe(before[0].id)
  })

  it('substitutes values and leaves empty ones as typed', () => {
    const vars = [kv('id', '42'), kv('slug', '')]
    expect(applyPathVariables('{{base}}/u/:id/:slug?q=:id', vars)).toBe('{{base}}/u/42/:slug?q=:id')
    expect(applyPathVariables('/u/:id', undefined)).toBe('/u/:id')
  })

  it('resolves {{variables}} inside values when preparing', () => {
    const req = newRequest({ url: '{{base}}/users/:id', pathVariables: [kv('id', '{{userId}}')] })
    const scopes = { ...emptyScopes(), environment: { base: 'https://api.test', userId: '7' } }
    expect(prepareRequest(req, { type: 'none' }, scopes).url).toBe('https://api.test/users/7')
    expect(missingVariables(req, { type: 'none' }, { ...emptyScopes(), environment: { base: 'x' } })).toEqual(['userId'])
  })

  it('imports v1 path variables', () => {
    const v1 = {
      id: 'c',
      name: 'Old',
      order: ['r'],
      requests: [
        {
          id: 'r',
          name: 'Get',
          url: 'https://old.test/users/:id',
          method: 'GET',
          pathVariableData: [{ key: 'id', value: '5', description: 'user id' }]
        }
      ]
    }
    const r = importText(JSON.stringify(v1)).collections[0].items[0]
    expect(r.kind === 'request' && r.pathVariables?.map((v) => [v.key, v.value, v.description])).toEqual([['id', '5', 'user id']])
  })

  it('exports path variables as url.variable and reads them back', () => {
    const c = newCollection({ items: [newRequest({ name: 'x', url: 'https://a.test/u/:id', pathVariables: [kv('id', '9', true, 'who')] })] })
    const url = (exportCollectionV21(c) as any).item[0].request.url
    expect(url.variable).toEqual([{ key: 'id', value: '9', description: 'who' }])
    const back = importText(JSON.stringify(exportCollectionV21(c))).collections[0].items[0]
    expect(back.kind === 'request' && back.pathVariables?.map((v) => [v.key, v.value])).toEqual([['id', '9']])
  })
})

describe('server-sent events', () => {
  it('parses events the way browsers do', () => {
    const events = parseSse(': comment\n\nevent: greet\ndata: hello\ndata: world\nid: 1\n\ndata:no-space\n\nretry: 3000\ndata: {"a":1}\n\n')
    expect(events).toEqual([
      { event: 'greet', data: 'hello\nworld', id: '1' },
      { event: 'message', data: 'no-space', id: '1' },
      { event: 'message', data: '{"a":1}', id: '1', retry: 3000 }
    ])
  })

  it('handles CRLF and marks the event still arriving', () => {
    expect(parseSse('data: a\r\n\r\ndata: b\r\ndata: c')).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b\nc', partial: true }
    ])
    expect(parseSse('')).toEqual([])
  })
})
