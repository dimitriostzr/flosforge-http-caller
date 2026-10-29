import { describe, expect, it } from 'vitest'
import { kv, newCollection, newFolder, newRequest, variable } from '@shared/model'
import type { HttpResponse, PreparedRequest } from '@shared/types'
import { csvCell, maskHeader, resultReport, runReport, toCsv } from '@shared/engine/exports'
import type { RunStep, RunSummary } from '@shared/engine/collectionRun'
import { emptyScopes } from '@shared/engine/variables'
import { exportItem } from '@shared/itemExport'
import { importText, parseCurl } from '@shared/importers'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

const response = (body: string, contentType = 'application/json', status = 200): HttpResponse => ({
  status,
  statusText: status === 200 ? 'OK' : 'Not Found',
  httpVersion: '1.1',
  headers: [
    ['Content-Type', contentType],
    ['Set-Cookie', 'session=abcdefghijklmnop']
  ],
  body: enc(body),
  bodySize: body.length,
  headersSize: 50,
  timings: { firstByte: 10, download: 2, total: 42 },
  url: 'https://api.test/users',
  redirects: [],
  requestHeaders: []
})

const request: PreparedRequest = {
  execId: 'x',
  method: 'GET',
  url: 'https://api.test/users',
  headers: [
    ['Authorization', 'Bearer super-secret-token-1234'],
    ['Accept', 'application/json']
  ],
  body: { type: 'none' }
}

const input = (res?: HttpResponse) => ({
  name: 'List users',
  at: Date.UTC(2026, 0, 2, 3, 4, 5),
  request,
  response: res,
  tests: [
    { name: 'status ok', passed: true },
    { name: 'has <three>', passed: false, error: 'expected 2 to equal 3' }
  ],
  logs: [{ level: 'log' as const, message: 'hello', source: 'List users' }]
})

describe('masking and CSV', () => {
  it('masks credentials but keeps a hint', () => {
    expect(maskHeader('Authorization', 'Bearer super-secret-token-1234')).toBe('Bearer ••••1234')
    expect(maskHeader('x-api-key', 'abc')).toBe('••••')
    expect(maskHeader('Accept', 'application/json')).toBe('application/json')
  })

  it('escapes CSV cells per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvCell(null)).toBe('')
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2\r\n')
  })
})

describe('response reports', () => {
  const res = response('[{"id":1,"name":"Ada"},{"id":2,"name":"Grace","tags":["x"]}]')

  it('writes Markdown with status, tests, masked headers and a fenced body', () => {
    const md = resultReport(input(res), 'md')
    expect(md).toContain('# List users')
    expect(md).toContain('Status **200 OK**')
    expect(md).toContain('❌ has <three> — expected 2 to equal 3')
    expect(md).toContain('| Authorization | Bearer ••••1234 |')
    expect(md).not.toContain('super-secret')
    expect(md).toContain('```json\n[\n  {\n    "id": 1')
  })

  it('uses a longer fence when the body contains backticks', () => {
    const md = resultReport(input(response('use ``` to fence', 'text/plain')), 'md')
    expect(md).toContain('````\nuse ``` to fence\n````')
  })

  it('exports a JSON list body as a CSV table', () => {
    expect(resultReport(input(res), 'csv')).toBe('id,name,tags\r\n1,Ada,\r\n2,Grace,"[""x""]"\r\n')
  })

  it('falls back to a summary CSV for other bodies', () => {
    const csv = resultReport(input(response('<p>hi</p>', 'text/html')), 'csv')
    expect(csv).toContain('status,200 OK')
    expect(csv).toContain('test: has <three>,failed: expected 2 to equal 3')
  })

  it('writes text, JSON and escaped HTML', () => {
    expect(resultReport(input(res), 'txt')).toContain('[FAIL] has <three> - expected 2 to equal 3')
    const json = JSON.parse(resultReport(input(res), 'json'))
    expect(json.response.status).toBe(200)
    expect(JSON.stringify(json)).not.toContain('super-secret')
    expect(JSON.stringify(json)).not.toContain('abcdefghijklmnop')
    const html = resultReport(input(res), 'html')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('has &lt;three&gt;')
    expect(html).not.toContain('super-secret')
  })

  it('lists the headers actually sent when the response has them', () => {
    const res2 = { ...response('{}'), requestHeaders: [['User-Agent', 'FlosForge-Caller/1'], ['Cookie', 'sid=abcdefghijkl']] as [string, string][] }
    const md = resultReport(input(res2), 'md')
    expect(md).toContain('| User-Agent | FlosForge-Caller/1 |')
    expect(md).toContain('| Cookie | ••••ijkl |')
  })

  it('reports a failed request', () => {
    const md = resultReport({ ...input(), error: 'Connection refused' }, 'md')
    expect(md).toContain('> **Error:** Connection refused')
  })
})

describe('run reports', () => {
  const step = (over: Partial<RunStep>): RunStep => ({
    iteration: 0,
    index: 0,
    requestId: 'r',
    name: 'A',
    method: 'GET',
    url: 'http://a',
    status: 200,
    timeMs: 12,
    sizeBytes: 3,
    tests: [{ name: 't', passed: true }],
    logs: [],
    scriptErrors: [],
    skipped: false,
    passed: true,
    ...over
  })
  const steps = [step({}), step({ iteration: 1, name: 'B, "quoted"', passed: false, tests: [{ name: 't', passed: false, error: 'nope' }] })]
  const summary: RunSummary = {
    startedAt: 0,
    finishedAt: 1500,
    totalIterations: 2,
    iterations: 2,
    requests: 2,
    failedRequests: 1,
    tests: { passed: 1, failed: 1, skipped: 0 },
    avgResponseMs: 12,
    stoppedBecause: 'completed',
    scopes: emptyScopes()
  }

  it('writes one CSV row per request', () => {
    const lines = runReport('API', summary, steps, 'csv').trim().split('\r\n')
    expect(lines[0]).toBe('iteration,request,method,url,status,time_ms,size_bytes,tests_passed,tests_failed,result,problem')
    expect(lines[2]).toBe('2,"B, ""quoted""",GET,http://a,200,12,3,0,1,failed,t: nope')
  })

  it('writes Markdown and text summaries with the failures listed', () => {
    const md = runReport('API', summary, steps, 'md')
    expect(md).toContain('| Requests | 2 | 1 |')
    expect(md).toContain('1. **B, "quoted"** (iteration 2): t: nope')
    expect(runReport('API', summary, steps, 'txt')).toContain('[FAIL] GET    B, "quoted"')
  })
})

describe('exporting requests and folders', () => {
  const login = newRequest({ name: 'Login', method: 'POST', url: '{{base}}/login', headers: [kv('X-Trace', '{{trace}}')] })
  login.body.mode = 'raw'
  login.body.raw = '{"user":"{{user}}"}'
  const folder = newFolder({ name: 'Auth flows', items: [login] })
  const collection = newCollection({
    name: 'API',
    auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    variables: [variable('base', 'https://api.test')],
    items: [folder]
  })

  it('exports a request as a v2.1 collection that imports back with its auth baked in', () => {
    const file = exportItem(collection, login, 'collection')
    expect(file.fileName).toBe('Login.collection.json')
    const back = importText(file.content).collections[0]
    expect(back.name).toBe('Login')
    expect(back.variables.map((v) => [v.key, v.value])).toEqual([['base', 'https://api.test']])
    const req = back.items[0]
    expect(req).toMatchObject({ kind: 'request', name: 'Login', method: 'POST', url: '{{base}}/login' })
    expect(req.kind === 'request' && req.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } })
    expect(req.kind === 'request' && req.body.raw).toBe('{"user":"{{user}}"}')
  })

  it('exports a request in the native format, which imports as an open request', () => {
    const file = exportItem(collection, login, 'native')
    expect(file.fileName).toBe('Login.ffcaller.json')
    const back = importText(file.content)
    expect(back.collections).toEqual([])
    expect(back.request).toMatchObject({ name: 'Login', method: 'POST', url: '{{base}}/login' })
    expect(back.request!.id).not.toBe(login.id)
    expect(back.request!.auth.type).toBe('bearer')
  })

  it('exports cURL that keeps {{variables}} and parses back', () => {
    const file = exportItem(collection, login, 'curl')
    expect(file.content).toContain("curl '{{base}}/login'")
    expect(file.content).toContain("--header 'Authorization: Bearer {{token}}'")
    const back = parseCurl(file.content)
    expect(back.method).toBe('POST')
    expect(back.url).toBe('{{base}}/login')
    expect(back.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } })
  })

  it('puts Basic auth with variables in --user so it survives the round trip', () => {
    const r = newRequest({ name: 'Basic', url: 'https://x', auth: { type: 'basic', basic: { username: '{{u}}', password: "p'w" } } })
    const file = exportItem(newCollection({ items: [r] }), r, 'curl')
    expect(file.content).toContain(`--user '{{u}}:p'\\''w'`)
    expect(parseCurl(file.content).auth).toEqual({ type: 'basic', basic: { username: '{{u}}', password: "p'w" } })
  })

  it('exports a folder as a collection in both formats', () => {
    const v21 = importText(exportItem(collection, folder, 'collection').content).collections[0]
    expect(v21.name).toBe('Auth flows')
    expect(v21.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}' } })
    expect(v21.items.map((i) => i.name)).toEqual(['Login'])
    const native = importText(exportItem(collection, folder, 'native').content).collections[0]
    expect(native.items.map((i) => i.name)).toEqual(['Login'])
    expect(() => exportItem(collection, folder, 'curl')).toThrow(/single request/)
  })
})
