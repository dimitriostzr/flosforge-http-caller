import { describe, expect, it } from 'vitest'
import { exportCollectionV21, exportEnvironmentFile, exportNative, importText } from '../src/shared/importers'
import { COLLECTION_SCHEMA_V21 } from '../src/shared/importers/collectionFormat'
import { newCollection, newEnvironment, newRequest, variable } from '../src/shared/model'
import type { ApiRequest, Collection, Folder, TreeItem } from '../src/shared/types'

const v21 = {
  info: {
    _postman_id: '1d2c3b4a-0000-4000-8000-000000000001',
    name: 'Shop API',
    description: { content: 'All shop endpoints', type: 'text/markdown' },
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: ["console.log('collection pre')"] } }
  ],
  variable: [
    { key: 'baseUrl', value: 'https://api.shop.test', type: 'string' },
    { key: 'old', value: 'x', disabled: true }
  ],
  item: [
    {
      name: 'Products',
      description: 'Product endpoints',
      auth: {
        type: 'apikey',
        apikey: [
          { key: 'value', value: 'secret-key', type: 'string' },
          { key: 'key', value: 'X-API-Key', type: 'string' },
          { key: 'in', value: 'header', type: 'string' }
        ]
      },
      item: [
        {
          name: 'List products',
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['const a = 1', 'pm.variables.set("a", a)'], type: 'text/javascript' }
            },
            {
              listen: 'test',
              script: { exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200)', '})'] }
            }
          ],
          request: {
            method: 'GET',
            header: [
              { key: 'Accept', value: 'application/json' },
              { key: 'X-Debug', value: '1', disabled: true, description: 'debug only' }
            ],
            url: {
              raw: '{{baseUrl}}/products?page=1&limit=20',
              host: ['{{baseUrl}}'],
              path: ['products'],
              query: [
                { key: 'page', value: '1' },
                { key: 'sort', value: 'price', disabled: true, description: 'sort order' },
                { key: 'limit', value: '20' }
              ]
            }
          },
          response: [{ name: 'example', code: 200, body: '[]' }]
        },
        {
          name: 'Variants',
          item: [
            {
              name: 'Get variant',
              request: {
                method: 'get',
                url: {
                  raw: '{{baseUrl}}/products/:id/variants/:vid',
                  host: ['{{baseUrl}}'],
                  path: ['products', ':id', 'variants', ':vid'],
                  variable: [{ key: 'id', value: '42' }, { key: 'vid', value: '7' }]
                }
              }
            }
          ]
        }
      ]
    },
    {
      name: 'Create order',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{\n  "productId": 42\n}',
          options: { raw: { language: 'json' } }
        },
        url: '{{baseUrl}}/orders',
        description: 'Creates an order'
      }
    },
    {
      name: 'Login',
      request: {
        method: 'POST',
        auth: { type: 'noauth' },
        body: {
          mode: 'urlencoded',
          urlencoded: [
            { key: 'username', value: 'bob', type: 'text' },
            { key: 'password', value: 'hunter2', type: 'text' },
            { key: 'remember', value: 'true', type: 'text', disabled: true }
          ]
        },
        url: { raw: '{{baseUrl}}/login', host: ['{{baseUrl}}'], path: ['login'] }
      }
    },
    {
      name: 'Upload avatar',
      request: {
        method: 'POST',
        auth: { type: 'digest', digest: [{ key: 'username', value: 'u' }] },
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'caption', value: 'Me', type: 'text' },
            { key: 'avatar', type: 'file', src: '/home/me/avatar.png', contentType: 'image/png' },
            { key: 'extra', type: 'file', src: ['/a.txt', '/b.txt'] }
          ]
        },
        url: '{{baseUrl}}/avatar'
      }
    },
    { name: 'Health', request: 'https://api.shop.test/health?verbose' },
    'garbage entry',
    {
      name: 'Upload file',
      request: { method: 'PUT', body: { mode: 'file', file: { src: '/tmp/data.bin' } }, url: '{{baseUrl}}/blob' }
    },
    {
      name: 'GraphQL',
      request: {
        method: 'POST',
        body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } },
        url: '{{baseUrl}}/graphql'
      }
    },
    {
      name: 'Disabled body',
      request: { method: 'POST', body: { mode: 'raw', raw: 'x', disabled: true }, url: '{{baseUrl}}/x' }
    }
  ]
}

const v20 = {
  info: {
    name: 'Legacy',
    schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json'
  },
  auth: { type: 'basic', basic: { username: 'admin', password: 'pw' } },
  item: [
    {
      name: 'Me',
      request: {
        url: 'https://legacy.test/me?x=1',
        method: 'GET',
        auth: { type: 'bearer', bearer: { token: 'abc' } },
        header: 'Accept: application/json\n// X-Off: 1\n'
      }
    },
    {
      name: 'Post xml',
      request: {
        url: { protocol: 'https', host: ['legacy', 'test'], path: ['xml'], query: [{ key: 'q', value: 'a b' }] },
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/xml' }],
        body: { mode: 'raw', raw: '<a/>' },
        auth: { type: 'apikey', apikey: { key: 'api_key', value: 'k', in: 'query' } }
      }
    }
  ]
}

const environment = {
  id: 'env-1',
  name: 'Staging',
  values: [
    { key: 'baseUrl', value: 'https://staging.test', enabled: true, type: 'default' },
    { key: 'token', value: 's3cr3t', enabled: true, type: 'secret' },
    { key: 'port', value: 8080, enabled: true },
    { key: 'debug', value: false, enabled: false }
  ],
  _postman_variable_scope: 'environment',
  _postman_exported_at: '2024-01-01T00:00:00.000Z'
}

const globalsExport = {
  id: 'g',
  name: 'Globals',
  values: [{ key: 'tenant', value: 'acme', enabled: true }],
  _postman_variable_scope: 'globals'
}

const dump = {
  version: 1,
  collections: [
    {
      id: 'c1',
      name: 'Old API',
      description: 'v1 format',
      order: ['r3'],
      folders_order: ['f1'],
      folders: [
        { id: 'f1', name: 'Users', order: ['r1'], folders_order: ['f2'] },
        { id: 'f2', name: 'Admin', order: ['r2'], folders_order: [] }
      ],
      requests: [
        {
          id: 'r1',
          name: 'List users',
          url: 'https://old.test/users?page=2',
          method: 'GET',
          headers: 'Accept: application/json\n',
          dataMode: 'params',
          data: [],
          tests: 'tests["ok"] = responseCode.code === 200',
          queryParams: [
            { key: 'page', value: '2', enabled: true },
            { key: 'debug', value: '1', enabled: false }
          ]
        },
        {
          id: 'r2',
          name: 'Create user',
          url: 'https://old.test/users',
          method: 'POST',
          headers: 'Content-Type: application/json\n',
          dataMode: 'raw',
          rawModeData: '{"name":"x"}',
          preRequestScript: 'pm.environment.set("a", "b")',
          currentHelper: 'basicAuth',
          helperAttributes: { username: 'u', password: 'p' }
        },
        {
          id: 'r3',
          name: 'Login',
          url: 'https://old.test/login',
          method: 'POST',
          dataMode: 'urlencoded',
          data: [{ key: 'user', value: 'bob', type: 'text', enabled: true }]
        },
        {
          id: 'r4',
          name: 'Orphan',
          url: 'https://old.test/orphan',
          method: 'DELETE',
          dataMode: 'params',
          data: [
            { key: 'f', value: '/tmp/x.png', type: 'file', enabled: true },
            { key: 't', value: 'v', type: 'text', enabled: true }
          ]
        }
      ]
    },
    v20
  ],
  environments: [environment],
  globals: [{ key: 'g1', value: 'v1', enabled: true }]
}

const req = (items: TreeItem[], name: string): ApiRequest => {
  const found = items.find((i) => i.name === name)
  if (!found || found.kind !== 'request') throw new Error(`request ${name} not found`)
  return found
}
const folder = (items: TreeItem[], name: string): Folder => {
  const found = items.find((i) => i.name === name)
  if (!found || found.kind !== 'folder') throw new Error(`folder ${name} not found`)
  return found
}

describe('Collection v2.1 import', () => {
  const result = importText(JSON.stringify(v21))
  const c = result.collections[0]

  it('imports collection metadata', () => {
    expect(result.collections).toHaveLength(1)
    expect(c.name).toBe('Shop API')
    expect(c.description).toBe('All shop endpoints')
    expect(c.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } })
    expect(c.scripts.preRequest).toBe("console.log('collection pre')")
    expect(c.variables.map((v) => [v.key, v.value, v.enabled])).toEqual([
      ['baseUrl', 'https://api.shop.test', true],
      ['old', 'x', false]
    ])
    expect(c.variables[0].id).toBeTruthy()
  })

  it('keeps nesting and order', () => {
    expect(c.items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'folder:Products',
      'request:Create order',
      'request:Login',
      'request:Upload avatar',
      'request:Health',
      'request:Upload file',
      'request:GraphQL',
      'request:Disabled body'
    ])
    const products = folder(c.items, 'Products')
    expect(products.description).toBe('Product endpoints')
    expect(products.items.map((i) => i.name)).toEqual(['List products', 'Variants'])
    expect(folder(products.items, 'Variants').items[0].name).toBe('Get variant')
  })

  it('maps folder apikey auth', () => {
    expect(folder(c.items, 'Products').auth).toEqual({
      type: 'apikey',
      apikey: { key: 'X-API-Key', value: 'secret-key', in: 'header' }
    })
  })

  it('maps params, headers and scripts', () => {
    const r = req(folder(c.items, 'Products').items, 'List products')
    expect(r.method).toBe('GET')
    expect(r.url).toBe('{{baseUrl}}/products?page=1&limit=20')
    expect(r.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '1', true],
      ['limit', '20', true],
      ['sort', 'price', false]
    ])
    expect(r.params[2].description).toBe('sort order')
    expect(r.headers.map((h) => [h.key, h.value, h.enabled])).toEqual([
      ['Accept', 'application/json', true],
      ['X-Debug', '1', false]
    ])
    expect(r.headers[1].description).toBe('debug only')
    expect(r.auth).toEqual({ type: 'inherit' })
    expect(r.scripts.preRequest).toBe('const a = 1\npm.variables.set("a", a)')
    expect(r.scripts.test).toBe('pm.test("ok", () => {\n  pm.response.to.have.status(200)\n})')
    expect(r.body.mode).toBe('none')
  })

  it('keeps path variables literally and warns once', () => {
    const r = req(folder(folder(c.items, 'Products').items, 'Variants').items, 'Get variant')
    expect(r.method).toBe('GET')
    expect(r.url).toBe('{{baseUrl}}/products/:id/variants/:vid')
    expect(r.params).toEqual([])
    expect(result.warnings.filter((w) => w.includes('path variables'))).toHaveLength(1)
  })

  it('maps raw JSON body and description', () => {
    const r = req(c.items, 'Create order')
    expect(r.url).toBe('{{baseUrl}}/orders')
    expect(r.description).toBe('Creates an order')
    expect(r.body.mode).toBe('raw')
    expect(r.body.rawLanguage).toBe('json')
    expect(r.body.raw).toBe('{\n  "productId": 42\n}')
  })

  it('maps urlencoded body and noauth', () => {
    const r = req(c.items, 'Login')
    expect(r.auth).toEqual({ type: 'none' })
    expect(r.body.mode).toBe('urlencoded')
    expect(r.body.urlencoded.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['username', 'bob', true],
      ['password', 'hunter2', true],
      ['remember', 'true', false]
    ])
  })

  it('maps formdata with files and warns about unsupported auth', () => {
    const r = req(c.items, 'Upload avatar')
    expect(r.body.mode).toBe('formdata')
    expect(r.body.formdata.map((f) => ({ key: f.key, kind: f.kind, value: f.value, files: f.files, ct: f.contentType }))).toEqual([
      { key: 'caption', kind: 'text', value: 'Me', files: undefined, ct: undefined },
      { key: 'avatar', kind: 'file', value: '', files: ['/home/me/avatar.png'], ct: 'image/png' },
      { key: 'extra', kind: 'file', value: '', files: ['/a.txt', '/b.txt'], ct: undefined }
    ])
    expect(r.auth).toEqual({ type: 'inherit' })
    expect(result.warnings.some((w) => w.includes('digest') && w.includes('Upload avatar'))).toBe(true)
  })

  it('accepts a request given as a plain string', () => {
    const r = req(c.items, 'Health')
    expect(r.method).toBe('GET')
    expect(r.url).toBe('https://api.shop.test/health?verbose')
    expect(r.params.map((p) => [p.key, p.value])).toEqual([['verbose', '']])
  })

  it('maps file, graphql and disabled bodies', () => {
    expect(req(c.items, 'Upload file').body).toMatchObject({ mode: 'binary', binaryPath: '/tmp/data.bin' })
    expect(req(c.items, 'GraphQL').body).toMatchObject({
      mode: 'graphql',
      graphql: { query: '{ me { id } }', variables: '{"a":1}' }
    })
    expect(req(c.items, 'Disabled body').body.mode).toBe('none')
  })

  it('warns about bad items instead of throwing', () => {
    expect(result.warnings.some((w) => w.includes('#6'))).toBe(true)
  })
})

describe('Collection v2.0 import', () => {
  const { collections } = importText(JSON.stringify(v20))
  const c = collections[0]

  it('reads object-style auth', () => {
    expect(c.auth).toEqual({ type: 'basic', basic: { username: 'admin', password: 'pw' } })
    expect(req(c.items, 'Me').auth).toEqual({ type: 'bearer', bearer: { token: 'abc' } })
    expect(req(c.items, 'Post xml').auth).toEqual({ type: 'apikey', apikey: { key: 'api_key', value: 'k', in: 'query' } })
  })

  it('parses string headers and rebuilds URLs from parts', () => {
    const me = req(c.items, 'Me')
    expect(me.headers.map((h) => [h.key, h.value, h.enabled])).toEqual([
      ['Accept', 'application/json', true],
      ['X-Off', '1', false]
    ])
    expect(me.params.map((p) => [p.key, p.value])).toEqual([['x', '1']])
    const xml = req(c.items, 'Post xml')
    expect(xml.url).toBe('https://legacy.test/xml?q=a b')
    expect(xml.body).toMatchObject({ mode: 'raw', raw: '<a/>', rawLanguage: 'xml' })
  })

  it('defaults to "none" auth when the collection has none', () => {
    const { collections } = importText(JSON.stringify({ info: { name: 'x' }, item: [] }))
    expect(collections[0].auth).toEqual({ type: 'none' })
  })
})

describe('environments and globals', () => {
  it('imports an environment', () => {
    const { environments, collections } = importText(JSON.stringify(environment))
    expect(collections).toEqual([])
    expect(environments).toHaveLength(1)
    const e = environments[0]
    expect(e.name).toBe('Staging')
    expect(e.variables.map((v) => [v.key, v.value, v.enabled, !!v.secret])).toEqual([
      ['baseUrl', 'https://staging.test', true, false],
      ['token', 's3cr3t', true, true],
      ['port', '8080', true, false],
      ['debug', 'false', false, false]
    ])
  })

  it('accepts environments without the scope marker', () => {
    const { environments } = importText(JSON.stringify({ name: 'Bare', values: [{ key: 'a', value: 'b' }] }))
    expect(environments[0].variables[0]).toMatchObject({ key: 'a', value: 'b', enabled: true })
  })

  it('imports globals', () => {
    const { globals, environments } = importText(JSON.stringify(globalsExport))
    expect(environments).toEqual([])
    expect(globals.map((g) => [g.key, g.value])).toEqual([['tenant', 'acme']])
  })

  it('exports an environment', () => {
    const e = newEnvironment({ name: 'Prod', variables: [variable('a', '1'), variable('t', 'x', false, true)] })
    const out = exportEnvironmentFile(e) as Record<string, unknown>
    expect(out._postman_variable_scope).toBe('environment')
    expect(out.values).toEqual([
      { key: 'a', value: '1', type: 'default', enabled: true },
      { key: 't', value: 'x', type: 'secret', enabled: false }
    ])
    const back = importText(JSON.stringify(out)).environments[0]
    expect(back.variables.map((v) => [v.key, v.value, v.enabled, !!v.secret])).toEqual([
      ['a', '1', true, false],
      ['t', 'x', false, true]
    ])
  })
})

describe('data dump', () => {
  const result = importText(JSON.stringify(dump))

  it('imports collections, environments and globals', () => {
    expect(result.collections.map((c) => c.name)).toEqual(['Old API', 'Legacy'])
    expect(result.environments.map((e) => e.name)).toEqual(['Staging'])
    expect(result.globals.map((g) => [g.key, g.value])).toEqual([['g1', 'v1']])
  })

  it('converts v1 collections with folder ordering', () => {
    const c = result.collections[0]
    expect(c.description).toBe('v1 format')
    expect(c.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['folder:Users', 'request:Login', 'request:Orphan'])
    const users = folder(c.items, 'Users')
    expect(users.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['folder:Admin', 'request:List users'])

    const list = req(users.items, 'List users')
    expect(list.url).toBe('https://old.test/users?page=2')
    expect(list.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '2', true],
      ['debug', '1', false]
    ])
    expect(list.headers.map((h) => [h.key, h.value])).toEqual([['Accept', 'application/json']])
    expect(list.scripts.test).toBe('tests["ok"] = responseCode.code === 200')

    const create = req(folder(users.items, 'Admin').items, 'Create user')
    expect(create.method).toBe('POST')
    expect(create.body).toMatchObject({ mode: 'raw', raw: '{"name":"x"}', rawLanguage: 'json' })
    expect(create.scripts.preRequest).toBe('pm.environment.set("a", "b")')
    expect(create.auth).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } })

    const login = req(c.items, 'Login')
    expect(login.body.mode).toBe('urlencoded')
    expect(login.body.urlencoded.map((p) => [p.key, p.value])).toEqual([['user', 'bob']])

    const orphan = req(c.items, 'Orphan')
    expect(orphan.method).toBe('DELETE')
    expect(orphan.body.formdata.map((f) => [f.key, f.kind, f.files])).toEqual([
      ['f', 'file', ['/tmp/x.png']],
      ['t', 'text', undefined]
    ])
  })

  it('accepts a standalone v1 collection', () => {
    const { collections } = importText(JSON.stringify(dump.collections[0]))
    expect(collections[0].name).toBe('Old API')
    expect(collections[0].items).toHaveLength(3)
  })
})

describe('format detection', () => {
  it('rejects invalid JSON and unknown shapes', () => {
    expect(() => importText('{ nope')).toThrow('File is not valid JSON')
    expect(() => importText('{"hello": 1}')).toThrow(/Unrecognized format/)
    expect(() => importText('[]')).toThrow(/Unrecognized format/)
  })

  it('accepts arrays of exports', () => {
    const r = importText(JSON.stringify([v20, environment, { foo: 1 }]))
    expect(r.collections).toHaveLength(1)
    expect(r.environments).toHaveLength(1)
    expect(r.warnings).toContain('Skipped entry #3: unrecognized format')
  })

  it('detects cURL commands', () => {
    const r = importText('  curl https://x.test/a -H "A: b"')
    expect(r.request?.url).toBe('https://x.test/a')
    expect(r.collections).toEqual([])
  })

  it('uses the file name when the export has no name', () => {
    for (const file of ['/tmp/My API.collection.json', '/tmp/My API.tool_collection.json', 'C:\\x\\My API.json']) {
      const r = importText(JSON.stringify({ info: {}, item: [] }), file)
      expect(r.collections[0].name).toBe('My API')
    }
  })
})

// Strip ids/timestamps so structures can be compared across imports.
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt') continue
      out[k] = shape(v)
    }
    return out
  }
  return value
}

describe('Collection v2.1 export', () => {
  const original = importText(JSON.stringify(v21)).collections[0]
  const exported = exportCollectionV21(original) as Record<string, any>

  it('produces v2.1 JSON', () => {
    expect(exported.info.schema).toBe(COLLECTION_SCHEMA_V21)
    expect(exported.info._postman_id).toBe(original.id)
    expect(exported.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] })
    const list = exported.item[0].item[0]
    expect(list.request.url).toEqual({
      raw: '{{baseUrl}}/products?page=1&limit=20',
      host: ['{{baseUrl}}'],
      path: ['products'],
      query: [
        { key: 'page', value: '1' },
        { key: 'limit', value: '20' },
        { key: 'sort', value: 'price', disabled: true, description: 'sort order' }
      ]
    })
    expect(list.event[1]).toEqual({
      listen: 'test',
      script: { type: 'text/javascript', exec: ['pm.test("ok", () => {', '  pm.response.to.have.status(200)', '})'] }
    })
    expect(list.request.auth).toBeUndefined()
    const login = exported.item.find((i: any) => i.name === 'Login')
    expect(login.request.auth).toEqual({ type: 'noauth' })
    const upload = exported.item.find((i: any) => i.name === 'Upload avatar')
    expect(upload.request.body.formdata[1]).toEqual({
      key: 'avatar',
      type: 'file',
      src: '/home/me/avatar.png',
      contentType: 'image/png'
    })
    const file = exported.item.find((i: any) => i.name === 'Upload file')
    expect(file.request.body).toEqual({ mode: 'file', file: { src: '/tmp/data.bin' } })
  })

  it('splits hosts, ports and protocols', () => {
    const c = newCollection({
      items: [newRequest({ name: 'x', url: 'http://localhost:3000/a/b?q=1#frag', params: [] })]
    })
    const url = (exportCollectionV21(c) as any).item[0].request.url
    expect(url).toMatchObject({ protocol: 'http', host: ['localhost'], port: '3000', path: ['a', 'b'], hash: 'frag' })
  })

  it('round-trips through import', () => {
    const again = importText(JSON.stringify(exported)).collections[0]
    expect(shape(again)).toEqual(shape(original))
  })
})

describe('native format', () => {
  it('round-trips with fresh ids', () => {
    const original = importText(JSON.stringify(v21)).collections[0]
    const env = newEnvironment({ name: 'E', variables: [variable('a', 'b')] })
    const text = JSON.stringify(exportNative([original], [env]))
    const r = importText(text)
    const c: Collection = r.collections[0]
    expect(c.id).not.toBe(original.id)
    expect(c.items[0].id).not.toBe(original.items[0].id)
    expect(c.variables[0].id).not.toBe(original.variables[0].id)
    expect(r.environments[0].id).not.toBe(env.id)
    expect(r.environments[0].variables[0].id).not.toBe(env.variables[0].id)
    expect(shape(c)).toEqual(shape(original))
    expect(shape(r.environments[0])).toEqual(shape(env))
  })
})
