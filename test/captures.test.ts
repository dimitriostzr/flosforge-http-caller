import { describe, expect, it } from 'vitest'
import { newCapture, newCollection, newRequest } from '@shared/model'
import type { ExecResult } from '@shared/types'
import {
  applyCaptures,
  capturesScript,
  extractCapture,
  formatJsonPath,
  jsonEntries,
  nameForPath,
  parseJsonPath,
  suggestCaptures,
  type CaptureResponse
} from '@shared/engine/captures'
import { runCollection } from '@shared/engine/collectionRun'
import type { EngineDeps } from '@shared/engine/execute'
import { emptyScopes } from '@shared/engine/variables'
import type { ScriptJob, ScriptOutcome } from '@shared/engine/scriptTypes'
import { exportCollectionV21 } from '@shared/importers'

const okJson = (value: unknown): ExecResult => ({
  ok: true,
  response: {
    status: 200,
    statusText: 'OK',
    httpVersion: '1.1',
    headers: [['Content-Type', 'application/json']],
    body: new TextEncoder().encode(JSON.stringify(value)),
    bodySize: 0,
    headersSize: 0,
    timings: { firstByte: 1, download: 1, total: 10 },
    url: 'http://x',
    redirects: [],
    requestHeaders: []
  }
})

const res: CaptureResponse = {
  status: 201,
  headers: [
    ['Location', '/orders/42'],
    ['Set-Cookie', 'session=abc123; Path=/; HttpOnly'],
    ['Set-Cookie', 'theme=dark']
  ],
  body: JSON.stringify({ access_token: 'tok', data: { items: [{ id: 1 }, { id: 2, 'first-name': 'Ada' }] }, n: 7, flag: false })
}

describe('JSON paths', () => {
  it('reads dots, brackets, quotes and negative indexes', () => {
    expect(parseJsonPath('$.data.items[0].id')).toEqual(['data', 'items', 0, 'id'])
    expect(parseJsonPath('data.items.1.id')).toEqual(['data', 'items', 1, 'id'])
    expect(parseJsonPath(`$['data']["items"][-1]['first-name']`)).toEqual(['data', 'items', -1, 'first-name'])
    expect(parseJsonPath('$')).toEqual([])
    expect(parseJsonPath('$.a[')).toBeNull()
    expect(parseJsonPath('$.a[*]')).toBeNull()
    expect(parseJsonPath('$..a')).toBeNull()
  })

  it('formats paths that read back', () => {
    const p = ['data', 'items', 0, 'first-name']
    expect(formatJsonPath(p)).toBe('$.data.items[0]["first-name"]')
    expect(parseJsonPath(formatJsonPath(p))).toEqual(p)
  })
})

describe('extracting', () => {
  const get = (c: Partial<Parameters<typeof extractCapture>[0]>) => extractCapture({ source: 'body', path: '', regex: '', ...c }, res)

  it('takes body values, as text', () => {
    expect(get({ path: '$.access_token' })).toEqual({ value: 'tok' })
    expect(get({ path: '$.n' })).toEqual({ value: '7' })
    expect(get({ path: '$.flag' })).toEqual({ value: 'false' })
    expect(get({ path: '$.data.items[-1]["first-name"]' })).toEqual({ value: 'Ada' })
    expect(get({ path: '$.data.items[0]' })).toEqual({ value: '{"id":1}' })
    expect(get({ path: '' })).toEqual({ value: res.body })
  })

  it('takes headers, cookies and the status', () => {
    expect(get({ source: 'header', path: 'location' })).toEqual({ value: '/orders/42' })
    expect(get({ source: 'cookie', path: 'session' })).toEqual({ value: 'abc123' })
    expect(get({ source: 'status' })).toEqual({ value: '201' })
  })

  it('narrows with a pattern', () => {
    expect(get({ source: 'header', path: 'Location', regex: '/orders/(\\d+)' })).toEqual({ value: '42' })
    expect(get({ source: 'status', regex: '^2' })).toEqual({ value: '2' })
  })

  it('explains what went wrong', () => {
    expect(get({ path: '$.missing' })).toEqual({ error: 'Nothing at $.missing' })
    expect(get({ path: '$.data.items[5]' })).toEqual({ error: 'Nothing at $.data.items[5]' })
    expect(extractCapture({ source: 'body', path: '$.a', regex: '' }, { ...res, body: '<html>' })).toEqual({ error: 'The body isn’t JSON' })
    expect(get({ source: 'header', path: 'X-Nope' })).toEqual({ error: 'No X-Nope header in the response' })
    expect(get({ source: 'cookie', path: 'nope' })).toEqual({ error: 'The response set no nope cookie' })
    expect(get({ source: 'header', path: 'Location', regex: 'x(' })).toMatchObject({ error: expect.stringMatching(/^Invalid pattern/) })
    expect(get({ source: 'header', path: 'Location', regex: '^nope' })).toEqual({ error: 'The pattern /^nope/ didn’t match' })
  })
})

describe('applying', () => {
  it('writes each scope and keeps values for the run when a scope is missing', () => {
    const caps = [
      newCapture({ variable: 'token', path: '$.access_token', scope: 'environment' }),
      newCapture({ variable: '{{orderId}}', source: 'header', path: 'Location', regex: '(\\d+)$', scope: 'collection' }),
      newCapture({ variable: 'g', source: 'status', scope: 'globals' }),
      newCapture({ variable: 'off', path: '$.n', enabled: false }),
      newCapture({ variable: 'bad', path: '$.nope' })
    ]
    const a = applyCaptures(caps, res, emptyScopes(), { environment: true, collection: true })
    expect(a.scopes.environment).toEqual({ token: 'tok' })
    expect(a.scopes.collection).toEqual({ orderId: '42' })
    expect(a.scopes.globals).toEqual({ g: '201' })
    expect(a.results.map((r) => [r.variable, r.value ?? r.error])).toEqual([
      ['token', 'tok'],
      ['orderId', '42'],
      ['g', '201'],
      ['bad', 'Nothing at $.nope']
    ])

    const b = applyCaptures(caps.slice(0, 2), res, emptyScopes(), { environment: false, collection: false })
    expect(b.scopes.local).toEqual({ token: 'tok', orderId: '42' })
    expect(b.results.every((r) => r.scope === 'local' && r.note)).toBe(true)
  })

  it('runs before the test scripts and feeds the next request in a run', async () => {
    const sent: string[] = []
    const seenByTests: Record<string, string>[] = []
    const login = newRequest({ name: 'Login', url: 'http://api/login', captures: [newCapture({ variable: 'token', path: '$.access_token' })] })
    const me = newRequest({ name: 'Me', url: 'http://api/me?t={{token}}' })
    const deps: EngineDeps = {
      send: async (req): Promise<ExecResult> => {
        sent.push(req.url)
        return okJson({ access_token: 'from-login' })
      },
      runScripts: async (job: ScriptJob): Promise<ScriptOutcome> => {
        if (job.phase === 'test') seenByTests.push({ ...job.scopes.environment })
        return { scopes: structuredClone(job.scopes), request: job.request, tests: [], logs: [] }
      }
    }
    // A test script, so the fake sandbox runs and records what the tests saw.
    login.scripts.test = 'x'
    const summary = await runCollection({
      collection: newCollection({ items: [login, me] }),
      items: [
        { request: login, parents: [] },
        { request: me, parents: [] }
      ],
      scopes: emptyScopes(),
      options: {
        iterations: 1,
        delayMs: 0,
        bail: false,
        opts: { timeoutMs: 0, followRedirects: true, maxRedirects: 5, verifySsl: true, useCookieJar: false },
        scriptTimeoutMs: 1000
      },
      deps
    })
    expect(seenByTests[0]).toEqual({ token: 'from-login' })
    expect(sent).toEqual(['http://api/login', 'http://api/me?t=from-login'])
    expect(summary.scopes.environment.token).toBe('from-login')
  })
})

describe('exporting', () => {
  it('turns captures into test-script lines that do the same', () => {
    const script = capturesScript([
      newCapture({ variable: 'token', path: '$.data.items[-1]["first-name"]' }),
      newCapture({ variable: 'id', source: 'header', path: 'Location', regex: '(\\d+)', scope: 'collection' }),
      newCapture({ variable: 'off', enabled: false })
    ])
    expect(script).toBe(
      [
        '// Captures (made in FlosForge Caller)',
        `try { const v = pm.response.json()["data"]["items"].at(-1)["first-name"]; if (v !== undefined) pm.environment.set("token", typeof v === 'string' ? v : JSON.stringify(v)) } catch (e) {}`,
        `try { const m = String(pm.response.headers.get("Location")).match(new RegExp("(\\\\d+)")); if (m) pm.collectionVariables.set("id", m[1] ?? m[0]) } catch (e) {}`
      ].join('\n')
    )
  })

  it('runs and sets the same values as the captures', () => {
    const caps = [
      newCapture({ variable: 'token', path: '$.access_token' }),
      newCapture({ variable: 'last', path: '$.data.items[-1]["first-name"]', scope: 'globals' }),
      newCapture({ variable: 'item', path: '$.data.items[0]', scope: 'local' }),
      newCapture({ variable: 'orderId', source: 'header', path: 'Location', regex: '(\\d+)$', scope: 'collection' }),
      newCapture({ variable: 'session', source: 'cookie', path: 'session' }),
      newCapture({ variable: 'code', source: 'status' }),
      newCapture({ variable: 'never', path: '$.missing' })
    ]
    const set: Record<string, Record<string, string>> = { environment: {}, collectionVariables: {}, globals: {}, variables: {} }
    const scope = (name: string) => ({ set: (k: string, v: string) => void (set[name][k] = v) })
    const pm = {
      environment: scope('environment'),
      collectionVariables: scope('collectionVariables'),
      globals: scope('globals'),
      variables: scope('variables'),
      cookies: { get: (n: string) => (n === 'session' ? 'abc123' : undefined) },
      response: {
        code: res.status,
        json: () => JSON.parse(res.body),
        text: () => res.body,
        headers: { get: (n: string) => res.headers.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] }
      }
    }
    new Function('pm', capturesScript(caps))(pm)
    const direct = applyCaptures(caps, res, emptyScopes(), { environment: true, collection: true }).scopes
    expect(set.environment).toEqual(direct.environment)
    expect(set.collectionVariables).toEqual(direct.collection)
    expect(set.globals).toEqual(direct.globals)
    expect(set.variables).toEqual(direct.local)
  })

  it('appends them to the test script in collection files', () => {
    const c = newCollection({
      items: [newRequest({ name: 'Login', scripts: { preRequest: '', test: 'pm.test("ok", () => {})' }, captures: [newCapture({ variable: 't', path: '$.t' })] })]
    })
    const exec = (exportCollectionV21(c) as any).item[0].event[0].script.exec.join('\n')
    expect(exec).toMatch(/^pm\.test\("ok", \(\) => \{\}\)\n\n\/\/ Captures/)
    expect(exec).toContain('pm.environment.set("t"')
  })
})

describe('filling captures in from a response', () => {
  it('lists every value, containers first', () => {
    expect(jsonEntries({ a: { b: [1, 2] } }).map((e) => formatJsonPath(e.path))).toEqual(['$.a', '$.a.b', '$.a.b[0]', '$.a.b[1]'])
    expect(jsonEntries({ a: [1, 2, 3] }, 2)).toHaveLength(2)
  })

  it('names a variable after its key', () => {
    expect(nameForPath(['data', 'access_token'])).toBe('access_token')
    expect(nameForPath(['items', 0])).toBe('items')
    expect(nameForPath(['first-name'])).toBe('first-name')
    expect(nameForPath([])).toBe('')
  })

  it('suggests tokens, ids and cursors, shallow first, plus Location and cookies', () => {
    const body = {
      valid: true,
      paid: 3,
      items: [{ id: 'first', ownerId: 'o1' }, { id: 'second' }],
      meta: { nextCursor: 'c2' },
      access_token: 'tok',
      user: { userId: 'u1' }
    }
    const got = suggestCaptures({ status: 201, headers: [['Location', '/orders/9'], ['Set-Cookie', 'sid=s1; Path=/']], body: JSON.stringify(body) })
    expect(got.map((s) => `${s.capture.variable}<-${s.capture.source}:${s.capture.path}=${s.preview}`)).toEqual([
      'access_token<-body:$.access_token=tok',
      'nextCursor<-body:$.meta.nextCursor=c2',
      'userId<-body:$.user.userId=u1',
      'id<-body:$.items[0].id=first',
      'ownerId<-body:$.items[0].ownerId=o1',
      'location<-header:Location=/orders/9'
    ])
    expect(suggestCaptures({ status: 200, headers: [['Set-Cookie', 'sid=s1']], body: 'plain' }).map((s) => s.capture.variable)).toEqual(['sid'])
  })
})
