/// <reference lib="webworker" />
// Script sandbox. Runs pm.*-style pre-request and test scripts inside a
// dedicated Web Worker: no DOM, no access to the app's preload API, and
// (in production) a CSP that blocks direct network access. Scripts reach the
// network only through pm.sendRequest, which is proxied by the host.

import * as chai from 'chai'
import _ from 'lodash'
import CryptoJS from 'crypto-js'
import type {
  LogEntry,
  ScriptJob,
  ScriptOutcome,
  ScriptRequest,
  ScriptResponse,
  SendRequestSpec,
  TestResult,
  WorkerInbound,
  WorkerOutbound
} from '@shared/engine/scriptTypes'
import { lookup, resolve, type Scopes, type VarMap } from '@shared/engine/variables'

declare const self: DedicatedWorkerGlobalScope

const post = (msg: WorkerOutbound): void => self.postMessage(msg)

// --- pm.sendRequest plumbing -------------------------------------------------

let nextRequestId = 1
const pendingRequests = new Map<number, (r: { error?: string; response?: ScriptResponse }) => void>()

function hostSend(spec: SendRequestSpec): Promise<{ error?: string; response?: ScriptResponse }> {
  const id = nextRequestId++
  return new Promise((res) => {
    pendingRequests.set(id, res)
    post({ type: 'sendRequest', id, spec })
  })
}

// --- Helpers -------------------------------------------------------------------

const RESPONSE = Symbol('pm.response')

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

const toStoredValue = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)

interface Pair {
  key: string
  value: string
  disabled?: boolean
}

/** Minimal take on the pm API's PropertyList for headers and query params. */
class PropertyList {
  constructor(public members: Pair[]) {}
  private find(key: string): Pair | undefined {
    const k = key.toLowerCase()
    return this.members.find((m) => !m.disabled && m.key.toLowerCase() === k)
  }
  get(key: string): string | undefined {
    return this.find(key)?.value
  }
  has(key: string, value?: string): boolean {
    const m = this.find(key)
    return !!m && (value === undefined || m.value === value)
  }
  one(key: string): Pair | undefined {
    return this.find(key)
  }
  all(): Pair[] {
    return this.members.filter((m) => !m.disabled)
  }
  count(): number {
    return this.all().length
  }
  each(fn: (p: Pair) => void): void {
    this.all().forEach(fn)
  }
  map<T>(fn: (p: Pair) => T): T[] {
    return this.all().map(fn)
  }
  filter(fn: (p: Pair) => boolean): Pair[] {
    return this.all().filter(fn)
  }
  toObject(): Record<string, string> {
    return Object.fromEntries(this.all().map((m) => [m.key, m.value]))
  }
  add(item: Pair | string): void {
    this.members.push(typeof item === 'string' ? parseHeaderLine(item) : { key: item.key, value: toStoredValue(item.value) })
  }
  upsert(item: Pair): void {
    const m = this.find(item.key)
    if (m) m.value = toStoredValue(item.value)
    else this.add(item)
  }
  remove(key: string | ((p: Pair) => boolean)): void {
    const pred = typeof key === 'function' ? key : (p: Pair) => p.key.toLowerCase() === key.toLowerCase()
    this.members = this.members.filter((m) => !pred(m))
  }
  clear(): void {
    this.members = []
  }
  toString(): string {
    return this.all()
      .map((m) => `${m.key}: ${m.value}`)
      .join('\n')
  }
}

function parseHeaderLine(line: string): Pair {
  const i = line.indexOf(':')
  return i === -1 ? { key: line.trim(), value: '' } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
}

class VariableScope {
  constructor(
    private store: VarMap,
    readonly name: string,
    private scopes: Scopes
  ) {}
  get(key: string): string | undefined {
    return this.store[key]
  }
  set(key: string, value: unknown): void {
    this.store[key] = toStoredValue(value)
  }
  unset(key: string): void {
    delete this.store[key]
  }
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.store, key)
  }
  clear(): void {
    for (const k of Object.keys(this.store)) delete this.store[k]
  }
  toObject(): VarMap {
    return { ...this.store }
  }
  replaceIn(text: string): string {
    return resolve(text, this.scopes)
  }
}

// --- Request / response wrappers ----------------------------------------------

function makeUrl(raw: string) {
  const split = (s: string) => {
    const h = s.indexOf('#')
    const noHash = h === -1 ? s : s.slice(0, h)
    const q = noHash.indexOf('?')
    return {
      base: q === -1 ? noHash : noHash.slice(0, q),
      query: q === -1 ? '' : noHash.slice(q + 1),
      hash: h === -1 ? '' : s.slice(h + 1)
    }
  }
  const parts = split(raw)
  const url = {
    base: parts.base,
    hash: parts.hash,
    query: new PropertyList(
      parts.query
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const i = p.indexOf('=')
          return i === -1 ? { key: p, value: '' } : { key: p.slice(0, i), value: p.slice(i + 1) }
        })
    ),
    toString(): string {
      const q = this.query
        .all()
        .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
        .join('&')
      return this.base + (q ? `?${q}` : '') + (this.hash ? `#${this.hash}` : '')
    },
    update(next: string): void {
      const p = split(next)
      url.base = p.base
      url.hash = p.hash
      url.query = makeUrl(next).query
    },
    getHost(): string {
      return url.base.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0]
    },
    getPath(): string {
      const rest = url.base.replace(/^[a-z]+:\/\//i, '')
      const i = rest.indexOf('/')
      return i === -1 ? '/' : rest.slice(i)
    },
    getQueryString(): string {
      return this.query
        .all()
        .map((p) => `${p.key}=${p.value}`)
        .join('&')
    },
    getRaw(): string {
      return this.toString()
    }
  }
  return url
}

function makeRequest(src: ScriptRequest) {
  let url = makeUrl(src.url)
  const headers = new PropertyList(src.headers.map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled })))
  const body = {
    ...structuredClone(src.body),
    urlencodedList: new PropertyList(
      src.body.urlencoded.map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled }))
    ),
    update(next: string | { mode?: string; raw?: string }) {
      if (typeof next === 'string') {
        body.mode = 'raw'
        body.raw = next
      } else if (next && typeof next === 'object') {
        if (next.raw !== undefined) {
          body.mode = 'raw'
          body.raw = next.raw
        }
      }
    },
    toString(): string {
      return body.mode === 'raw' ? body.raw : ''
    }
  }
  const req = {
    id: src.id,
    name: src.name,
    method: src.method,
    headers,
    body,
    get url() {
      return url
    },
    set url(v: unknown) {
      url = makeUrl(typeof v === 'string' ? v : String(v))
    },
    addHeader(h: Pair) {
      headers.add(h)
    },
    removeHeader(key: string) {
      headers.remove(key)
    },
    upsertHeader(h: Pair) {
      headers.upsert(h)
    },
    toJSON() {
      return { method: req.method, url: url.toString(), header: headers.all(), body: { mode: body.mode, raw: body.raw } }
    },
    serialize(): ScriptRequest {
      return {
        id: src.id,
        name: src.name,
        method: String(req.method).toUpperCase(),
        url: url.toString(),
        headers: headers.members.map((m) => ({ key: m.key, value: m.value, enabled: !m.disabled })),
        body: {
          ...src.body,
          mode: body.mode,
          raw: body.raw,
          urlencoded: body.urlencodedList.members.map((m, i) => ({
            id: src.body.urlencoded[i]?.id ?? crypto.randomUUID(),
            key: m.key,
            value: m.value,
            enabled: !m.disabled
          }))
        }
      }
    }
  }
  return req
}

function parseCookies(headers: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue
    const first = v.split(';')[0]
    const i = first.indexOf('=')
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim()
  }
  return out
}

function makeResponse(src: ScriptResponse) {
  let parsed: unknown
  let parsedOk = false
  const cookies = parseCookies(src.headers)
  const res = {
    [RESPONSE]: true,
    code: src.code,
    status: src.status,
    responseTime: src.responseTime,
    responseSize: src.responseSize,
    headers: new PropertyList(src.headers.map(([key, value]) => ({ key, value }))),
    cookies: {
      get: (name: string) => cookies[name],
      has: (name: string) => name in cookies,
      toObject: () => ({ ...cookies })
    },
    reason: () => src.status,
    text: () => src.body,
    json: () => {
      if (!parsedOk) {
        parsed = JSON.parse(src.body)
        parsedOk = true
      }
      return parsed
    },
    get to() {
      return chai.expect(res).to
    }
  }
  return res
}

// --- chai extensions for pm.response.to.* ----------------------------------------

type ChaiAssertion = Chai.AssertionStatic & { _obj: ReturnType<typeof makeResponse> }

chai.use((c) => {
  const A = c.Assertion
  const isRes = (o: unknown): o is ReturnType<typeof makeResponse> =>
    !!o && typeof o === 'object' && (o as Record<symbol, unknown>)[RESPONSE] === true

  A.addMethod('status', function (this: ChaiAssertion, expected: number | string) {
    const r = this._obj
    if (typeof expected === 'number')
      this.assert(r.code === expected, 'expected response to have status code #{exp} but got #{act}', 'expected response to not have status code #{act}', expected, r.code)
    else
      this.assert(r.status === expected, 'expected response to have status reason #{exp} but got #{act}', 'expected response to not have status reason #{act}', expected, r.status)
  })

  A.addMethod('header', function (this: ChaiAssertion, name: string, value?: string) {
    const r = this._obj
    const actual = r.headers.get(name)
    this.assert(actual !== undefined, `expected response to have header ${name}`, `expected response to not have header ${name}`)
    if (value !== undefined)
      this.assert(actual === value, `expected '${name}' response header to be #{exp} but got #{act}`, `expected '${name}' response header to not be #{act}`, value, actual)
  })

  A.addMethod('body', function (this: ChaiAssertion, expected?: string | RegExp) {
    const text = this._obj.text()
    if (expected === undefined) this.assert(text.length > 0, 'expected response to have a body', 'expected response to not have a body')
    else if (expected instanceof RegExp) this.assert(expected.test(text), 'expected response body to match #{exp}', 'expected response body to not match #{exp}', String(expected))
    else this.assert(text === expected, 'expected response body to equal #{exp}', 'expected response body to not equal #{exp}', expected, text)
  })

  A.addMethod('jsonBody', function (this: ChaiAssertion, path?: string, value?: unknown) {
    let json: unknown
    try {
      json = this._obj.json()
    } catch {
      this.assert(false, 'expected response body to be valid JSON', '')
      return
    }
    if (path === undefined) return
    const has = _.has(json, path)
    if (arguments.length < 2) {
      this.assert(has, `expected response body json to have path '${path}'`, `expected response body json to not have path '${path}'`)
    } else {
      const actual = _.get(json, path)
      this.assert(_.isEqual(actual, value), `expected json property '${path}' to equal #{exp} but got #{act}`, `expected json property '${path}' to not equal #{act}`, value, actual)
    }
  })

  A.addProperty('json', function (this: ChaiAssertion) {
    let ok = true
    try {
      this._obj.json()
    } catch {
      ok = false
    }
    this.assert(ok, 'expected response body to be valid JSON', 'expected response body to not be valid JSON')
  })

  const range = (name: string, test: (code: number) => boolean, label: string): void => {
    A.addProperty(name, function (this: ChaiAssertion) {
      this.assert(test(this._obj.code), `expected response code to be ${label} but found #{act}`, `expected response code to not be ${label}`, undefined, this._obj.code)
    })
  }
  range('success', (c) => c >= 200 && c < 300, '2XX')
  range('info', (c) => c >= 100 && c < 200, '1XX')
  range('redirection', (c) => c >= 300 && c < 400, '3XX')
  range('clientError', (c) => c >= 400 && c < 500, '4XX')
  range('serverError', (c) => c >= 500, '5XX')
  range('accepted', (c) => c === 202, '202')
  range('badRequest', (c) => c === 400, '400')
  range('unauthorized', (c) => c === 401, '401')
  range('forbidden', (c) => c === 403, '403')
  range('notFound', (c) => c === 404, '404')
  range('rateLimited', (c) => c === 429, '429')

  // `ok`/`error` already exist in chai with different meanings; only change them for responses.
  A.overwriteProperty('ok', (_super: () => void) =>
    function (this: ChaiAssertion) {
      if (!isRes(this._obj)) return _super.call(this)
      const code = this._obj.code
      this.assert(code >= 200 && code < 300, 'expected response code to be 2XX but found #{act}', 'expected response code to not be 2XX', undefined, code)
    }
  )
  A.addProperty('error', function (this: ChaiAssertion) {
    const code = this._obj.code
    this.assert(code >= 400, 'expected response code to be 4XX or 5XX but found #{act}', 'expected response code to not be an error', undefined, code)
  })
})

// --- Running a job --------------------------------------------------------------

function normalizeSendSpec(input: unknown): SendRequestSpec {
  if (typeof input === 'string') return { url: input, method: 'GET', headers: [] }
  const o = (input ?? {}) as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url : String(o.url ?? '')
  let headers: [string, string][] = []
  const h = o.header ?? o.headers
  if (Array.isArray(h)) headers = h.map((x: Pair | string) => (typeof x === 'string' ? parseHeaderLine(x) : x)).map((x) => [x.key, toStoredValue(x.value)])
  else if (h && typeof h === 'object') headers = Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, toStoredValue(v)])
  let body: SendRequestSpec['body']
  const b = o.body as Record<string, unknown> | undefined
  if (b && b.mode === 'raw') body = { mode: 'raw', raw: toStoredValue(b.raw) }
  else if (b && b.mode === 'urlencoded' && Array.isArray(b.urlencoded))
    body = { mode: 'urlencoded', pairs: (b.urlencoded as Pair[]).map((p) => [p.key, toStoredValue(p.value)]) }
  return { url, method: String(o.method ?? 'GET').toUpperCase(), headers, body }
}

async function run(job: ScriptJob): Promise<ScriptOutcome> {
  const scopes = structuredClone(job.scopes)
  scopes.data ??= {}
  const iteration = job.info?.iteration ?? 0
  const iterationCount = job.info?.iterationCount ?? 1
  /** undefined = not set; null = stop the run; a name = continue with that request. */
  let nextRequest: string | null | undefined
  const setNextRequest = (name: unknown): void => {
    nextRequest = name === null || name === undefined ? null : String(name)
  }
  const logs: LogEntry[] = []
  const tests: TestResult[] = []
  const pending = new Set<Promise<unknown>>()
  const track = <T,>(p: Promise<T>): Promise<T> => {
    pending.add(p)
    void p.finally(() => pending.delete(p)).catch(() => {})
    return p
  }
  let firstError: string | undefined
  let skipRequest = false
  let source = ''

  const pmRequest = makeRequest(job.request)
  const pmResponse = job.response ? makeResponse(job.response) : undefined

  const logger = (level: LogEntry['level']) =>
    (...args: unknown[]) => logs.push({ level, message: args.map(stringify).join(' '), source })
  const scriptConsole = {
    log: logger('log'),
    info: logger('info'),
    warn: logger('warn'),
    error: logger('error'),
    debug: logger('debug'),
    table: logger('log'),
    dir: logger('log')
  }

  const reportError = (label: string, err: unknown): void => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : stringify(err)
    logs.push({ level: 'error', message: msg, source: label })
    firstError ??= `${label}: ${msg}`
  }

  const testFn = (name: string, fn?: (done?: (err?: unknown) => void) => unknown): void => {
    const result: TestResult = { name, passed: true }
    tests.push(result)
    if (typeof fn !== 'function') {
      result.skipped = true
      return
    }
    const fail = (err: unknown): void => {
      result.passed = false
      result.error = err instanceof Error ? err.message : stringify(err)
    }
    try {
      if (fn.length > 0) {
        track(
          new Promise<void>((res) => {
            fn((err?: unknown) => {
              if (err) fail(err)
              res()
            })
          })
        )
      } else {
        const out = fn()
        if (out && typeof (out as Promise<unknown>).then === 'function') track((out as Promise<unknown>).then(undefined, fail))
      }
    } catch (err) {
      fail(err)
    }
  }
  testFn.skip = (name: string): void => {
    tests.push({ name, passed: true, skipped: true })
  }

  const sendRequest = (input: unknown, callback?: (err: unknown, res?: unknown) => void): Promise<unknown> => {
    const label = source
    const p = hostSend(normalizeSendSpec(input)).then((r) => {
      const res = r.response ? makeResponse(r.response) : undefined
      const err = r.error ? new Error(r.error) : null
      if (callback) {
        try {
          callback(err, res)
        } catch (e) {
          reportError(label, e)
        }
        return res
      }
      if (err) throw err
      return res
    })
    // With a callback, errors are delivered to it; the returned promise must not reject unhandled.
    return track(callback ? p.catch(() => undefined) : p)
  }

  const pm = {
    info: {
      eventName: job.phase,
      requestName: job.request.name,
      requestId: job.request.id,
      iteration,
      iterationCount
    },
    environment: new VariableScope(scopes.environment, 'environment', scopes),
    collectionVariables: new VariableScope(scopes.collection, 'collection', scopes),
    globals: new VariableScope(scopes.globals, 'globals', scopes),
    iterationData: new VariableScope(scopes.data, 'data', scopes),
    variables: {
      get: (k: string) => lookup(scopes, k)?.value,
      set: (k: string, v: unknown) => {
        scopes.local[k] = toStoredValue(v)
      },
      unset: (k: string) => {
        delete scopes.local[k]
      },
      has: (k: string) => lookup(scopes, k) !== undefined,
      replaceIn: (t: string) => resolve(t, scopes),
      toObject: () => ({ ...scopes.globals, ...scopes.collection, ...scopes.environment, ...scopes.data, ...scopes.local })
    },
    request: pmRequest,
    response: pmResponse,
    cookies: pmResponse?.cookies ?? { get: () => undefined, has: () => false, toObject: () => ({}) },
    test: testFn,
    expect: chai.expect,
    sendRequest,
    execution: {
      skipRequest: () => {
        skipRequest = true
      },
      setNextRequest
    },
    setNextRequest,
    visualizer: { set: () => {}, clear: () => {} }
  }

  // Legacy (pre-`pm`) global script API, still common in older collections.
  const legacyTests: Record<string, boolean> = {}
  const postman = {
    setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v),
    getEnvironmentVariable: (k: string) => pm.environment.get(k),
    clearEnvironmentVariable: (k: string) => pm.environment.unset(k),
    clearEnvironmentVariables: () => pm.environment.clear(),
    setGlobalVariable: (k: string, v: unknown) => pm.globals.set(k, v),
    getGlobalVariable: (k: string) => pm.globals.get(k),
    clearGlobalVariable: (k: string) => pm.globals.unset(k),
    clearGlobalVariables: () => pm.globals.clear(),
    getResponseHeader: (k: string) => pmResponse?.headers.get(k),
    getResponseCookie: (k: string) => (pmResponse?.cookies.has(k) ? { name: k, value: pmResponse.cookies.get(k) } : undefined),
    setNextRequest
  }

  const modules: Record<string, unknown> = {
    chai,
    lodash: _,
    'crypto-js': CryptoJS,
    uuid: { v4: () => crypto.randomUUID() },
    buffer: undefined
  }
  const requireFn = (name: string): unknown => {
    if (modules[name] !== undefined) return modules[name]
    throw new Error(`Module "${name}" is not available in FlosForge Caller scripts`)
  }

  const env = {
    pm,
    postman,
    console: scriptConsole,
    tests: legacyTests,
    _,
    CryptoJS,
    require: requireFn,
    environment: scopes.environment,
    globals: scopes.globals,
    data: scopes.data,
    iteration,
    request: {
      url: job.request.url,
      method: job.request.method,
      name: job.request.name,
      headers: Object.fromEntries(job.request.headers.filter((h) => h.enabled).map((h) => [h.key, h.value])),
      data: job.request.body.raw
    },
    responseBody: job.response?.body,
    responseCode: job.response ? { code: job.response.code, name: job.response.status, detail: job.response.status } : undefined,
    responseHeaders: job.response ? Object.fromEntries(job.response.headers) : undefined,
    responseTime: job.response?.responseTime,
    responseCookies: pmResponse ? Object.entries(pmResponse.cookies.toObject()).map(([name, value]) => ({ name, value })) : undefined,
    setTimeout: (fn: () => void, ms?: number) => {
      const label = source
      let id = 0
      track(
        new Promise<void>((res) => {
          id = self.setTimeout(() => {
            try {
              fn()
            } catch (e) {
              reportError(label, e)
            }
            res()
          }, ms)
        })
      )
      return id
    }
  }
  const names = Object.keys(env)
  const values = names.map((n) => env[n as keyof typeof env])
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (
    ...args: unknown[]
  ) => Promise<unknown>

  for (const script of job.scripts) {
    if (!script.code.trim()) continue
    source = script.label
    try {
      const fn = new AsyncFunction(...names, script.code)
      await fn(...values)
    } catch (err) {
      reportError(script.label, err)
    }
    while (pending.size) await Promise.allSettled([...pending])
  }

  for (const [name, passed] of Object.entries(legacyTests)) tests.push({ name, passed: !!passed })

  return {
    scopes,
    request: pmRequest.serialize(),
    tests,
    logs,
    error: firstError,
    skipRequest,
    ...(nextRequest !== undefined ? { nextRequest } : {})
  }
}

self.onmessage = (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data
  if (msg.type === 'run') {
    run(msg.job).then(
      (outcome) => post({ type: 'done', outcome }),
      (err) =>
        post({
          type: 'done',
          outcome: { scopes: msg.job.scopes, request: msg.job.request, tests: [], logs: [], error: stringify(err) }
        })
    )
  } else if (msg.type === 'sendRequestResult') {
    const res = pendingRequests.get(msg.id)
    pendingRequests.delete(msg.id)
    res?.({ error: msg.error, response: msg.response })
  }
}
