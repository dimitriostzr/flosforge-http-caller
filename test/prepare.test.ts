import { describe, expect, it } from 'vitest'
import { formField, kv, newCollection, newFolder, newRequest } from '@shared/model'
import { paramsFromUrl, urlWithParams } from '@shared/url'
import { effectiveAuth, prepareRequest } from '@shared/engine/prepare'
import { emptyScopes, findVariableRefs, lookup, resolve, type Scopes } from '@shared/engine/variables'

const scopes = (partial: Partial<Scopes>): Scopes => ({ ...emptyScopes(), ...partial })

describe('variables', () => {
  it('resolves with precedence local > environment > collection > globals', () => {
    const s = scopes({
      globals: { a: 'g', b: 'g', c: 'g', d: 'g' },
      collection: { a: 'c', b: 'c', c: 'c' },
      environment: { a: 'e', b: 'e' },
      local: { a: 'l' }
    })
    expect(resolve('{{a}}-{{b}}-{{c}}-{{d}}', s)).toBe('l-e-c-g')
    expect(lookup(s, 'b')?.source).toBe('environment')
  })

  it('resolves nested references and leaves unknown ones intact', () => {
    const s = scopes({ environment: { host: 'api.test', base: 'https://{{host}}/v1' } })
    expect(resolve('{{base}}/users/{{ id }}', s)).toBe('https://api.test/v1/users/{{ id }}')
  })

  it('stops on self-referencing variables', () => {
    const s = scopes({ environment: { loop: '{{loop}}' } })
    expect(resolve('{{loop}}', s)).toBe('{{loop}}')
  })

  it('generates dynamic variables', () => {
    expect(resolve('{{$guid}}', emptyScopes())).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number(resolve('{{$timestamp}}', emptyScopes()))).toBeGreaterThan(1_600_000_000)
  })

  it('finds references with positions', () => {
    expect(findVariableRefs('a {{x}} b {{ y }}')).toEqual([
      { name: 'x', from: 2, to: 7 },
      { name: 'y', from: 10, to: 17 }
    ])
  })
})

describe('url params sync', () => {
  it('derives params from URL and keeps disabled ones', () => {
    const disabled = { ...kv('debug', '1'), enabled: false }
    const params = paramsFromUrl('{{base}}/x?a=1&b={{v}}&flag', [disabled])
    expect(params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['a', '1', true],
      ['b', '{{v}}', true],
      ['flag', '', true],
      ['debug', '1', false]
    ])
    expect(urlWithParams('{{base}}/x?old=1#frag', params)).toBe('{{base}}/x?a=1&b={{v}}&flag#frag')
  })
})

describe('auth inheritance', () => {
  it('walks request → folders → collection', () => {
    const collection = newCollection({ auth: { type: 'bearer', bearer: { token: 'col' } } })
    const outer = newFolder({ auth: { type: 'basic', basic: { username: 'u', password: 'p' } } })
    const inner = newFolder()
    const req = newRequest()
    expect(effectiveAuth(req, [outer, inner], collection).type).toBe('basic')
    expect(effectiveAuth(req, [inner], collection).type).toBe('bearer')
    expect(effectiveAuth(newRequest({ auth: { type: 'none' } }), [outer], collection).type).toBe('none')
    expect(effectiveAuth(req, [], null).type).toBe('none')
  })
})

describe('prepareRequest', () => {
  const s = scopes({ environment: { base: 'https://api.test', token: 'T', name: 'Zoë' } })

  it('resolves URL and headers and applies bearer auth', () => {
    const req = newRequest({
      method: 'post',
      url: '{{base}}/users?q={{name}}',
      headers: [kv('X-Name', '{{name}}'), { ...kv('X-Off', '1'), enabled: false }]
    })
    const p = prepareRequest(req, { type: 'bearer', bearer: { token: '{{token}}' } }, s)
    expect(p.method).toBe('POST')
    expect(p.url).toBe('https://api.test/users?q=Zoë')
    expect(p.headers).toEqual([
      ['X-Name', 'Zoë'],
      ['Authorization', 'Bearer T']
    ])
  })

  it('does not override an explicit Authorization header', () => {
    const req = newRequest({ url: 'x', headers: [kv('authorization', 'Custom 1')] })
    const p = prepareRequest(req, { type: 'bearer', bearer: { token: 'T' } }, s)
    expect(p.headers).toEqual([['authorization', 'Custom 1']])
  })

  it('encodes basic auth as UTF-8', () => {
    const p = prepareRequest(newRequest({ url: 'x' }), { type: 'basic', basic: { username: '{{name}}', password: 'pä' } }, s)
    const value = p.headers.find(([k]) => k === 'Authorization')![1]
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(value.slice(6)), (c) => c.charCodeAt(0)))
    expect(decoded).toBe('Zoë:pä')
  })

  it('adds api keys to the query string before the hash', () => {
    const p = prepareRequest(
      newRequest({ url: '{{base}}/a?x=1#top' }),
      { type: 'apikey', apikey: { key: 'api key', value: 'v&1', in: 'query' } },
      s
    )
    expect(p.url).toBe('https://api.test/a?x=1&api%20key=v%261#top')
  })

  it('builds raw JSON bodies with a default content type', () => {
    const req = newRequest({ url: 'x' })
    req.body.mode = 'raw'
    req.body.raw = '{"n":"{{name}}"}'
    const p = prepareRequest(req, { type: 'none' }, s)
    expect(p.body).toEqual({ type: 'text', text: '{"n":"Zoë"}' })
    expect(p.headers).toContainEqual(['Content-Type', 'application/json'])
  })

  it('keeps a user-set content type', () => {
    const req = newRequest({ url: 'x', headers: [kv('content-type', 'application/vnd.api+json')] })
    req.body.mode = 'raw'
    req.body.raw = '{}'
    const p = prepareRequest(req, { type: 'none' }, s)
    expect(p.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toEqual([['content-type', 'application/vnd.api+json']])
  })

  it('url-encodes form bodies and skips disabled fields', () => {
    const req = newRequest({ url: 'x' })
    req.body.mode = 'urlencoded'
    req.body.urlencoded = [kv('a b', '1&2'), kv('name', '{{name}}'), { ...kv('off', 'x'), enabled: false }]
    const p = prepareRequest(req, { type: 'none' }, s)
    expect(p.body).toEqual({ type: 'text', text: 'a%20b=1%262&name=Zo%C3%AB' })
  })

  it('expands multipart file fields into one part per file', () => {
    const req = newRequest({ url: 'x' })
    req.body.mode = 'formdata'
    req.body.formdata = [formField('title', '{{name}}'), { ...formField('files', '', 'file'), files: ['/a.txt', '/b.png'] }]
    const p = prepareRequest(req, { type: 'none' }, s)
    expect(p.body).toEqual({
      type: 'multipart',
      fields: [
        { name: 'title', value: 'Zoë', contentType: undefined },
        { name: 'files', filePath: '/a.txt', contentType: undefined },
        { name: 'files', filePath: '/b.png', contentType: undefined }
      ]
    })
  })

  it('wraps GraphQL queries and validates variables', () => {
    const req = newRequest({ url: 'x' })
    req.body.mode = 'graphql'
    req.body.graphql = { query: 'query { me }', variables: '{"id": 1}' }
    expect(prepareRequest(req, { type: 'none' }, s).body).toEqual({
      type: 'text',
      text: '{"query":"query { me }","variables":{"id":1}}'
    })
    req.body.graphql.variables = '{nope'
    expect(() => prepareRequest(req, { type: 'none' }, s)).toThrow(/not valid JSON/)
  })
})
