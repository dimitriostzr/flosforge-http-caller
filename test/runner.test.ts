import { describe, expect, it } from 'vitest'
import { newCollection, newRequest } from '@shared/model'
import type { ExecResult, HttpResponse } from '@shared/types'
import { runCollection, type RunItem, type RunStep } from '@shared/engine/collectionRun'
import type { EngineDeps } from '@shared/engine/execute'
import { parseCsv, parseDataFile } from '@shared/engine/data'
import { toJUnit, toJsonReport } from '@shared/engine/report'
import { emptyScopes } from '@shared/engine/variables'
import type { ScriptJob, ScriptOutcome } from '@shared/engine/scriptTypes'

const ok = (status = 200): ExecResult => ({
  ok: true,
  response: {
    status,
    statusText: 'OK',
    httpVersion: '1.1',
    headers: [],
    body: new Uint8Array(),
    bodySize: 0,
    headersSize: 0,
    timings: { firstByte: 1, download: 1, total: 10 },
    url: 'http://x',
    redirects: [],
    requestHeaders: []
  } satisfies HttpResponse
})

/**
 * Fake engine. "Scripts" are tiny JSON instructions in the request's test script,
 * e.g. {"set":{"token":"abc"},"next":"Login","fail":true}, so runs can be
 * steered without a real sandbox.
 */
function fakeDeps(sent: string[]): EngineDeps {
  return {
    send: async (req) => {
      sent.push(req.url)
      return ok()
    },
    runScripts: async (job: ScriptJob): Promise<ScriptOutcome> => {
      const code = job.scripts[job.scripts.length - 1].code
      const out: ScriptOutcome = { scopes: structuredClone(job.scopes), request: job.request, tests: [], logs: [] }
      if (!code) return out
      const cmd = JSON.parse(code)
      if (cmd.set) Object.assign(out.scopes.environment, cmd.set)
      if ('next' in cmd) out.nextRequest = cmd.next
      out.tests.push({ name: 'check', passed: !cmd.fail, error: cmd.fail ? 'expected failure' : undefined })
      return out
    }
  }
}

const item = (name: string, url: string, test = ''): RunItem => ({
  request: newRequest({ name, url, scripts: { preRequest: '', test } }),
  parents: []
})

const baseOptions = {
  iterations: 1,
  delayMs: 0,
  bail: false,
  opts: { timeoutMs: 0, followRedirects: true, maxRedirects: 5, verifySsl: true, useCookieJar: false },
  scriptTimeoutMs: 1000
}

describe('runCollection', () => {
  it('runs every request once per iteration and counts tests', async () => {
    const sent: string[] = []
    const steps: RunStep[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('A', 'http://a', '{}'), item('B', 'http://b', '{}')],
      scopes: emptyScopes(),
      options: { ...baseOptions, iterations: 3 },
      deps: fakeDeps(sent),
      onStep: (s) => steps.push(s)
    })
    expect(sent).toEqual(['http://a', 'http://b', 'http://a', 'http://b', 'http://a', 'http://b'])
    expect(summary).toMatchObject({ iterations: 3, requests: 6, failedRequests: 0, stoppedBecause: 'completed' })
    expect(summary.tests).toEqual({ passed: 6, failed: 0, skipped: 0 })
    expect(steps.map((s) => s.iteration)).toEqual([0, 0, 1, 1, 2, 2])
  })

  it('uses one data row per iteration as variables', async () => {
    const sent: string[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('User', 'http://api/users/{{id}}?name={{name}}')],
      scopes: emptyScopes(),
      options: { ...baseOptions, iterations: 99, data: [{ id: '1', name: 'ada' }, { id: '2', name: 'alan' }] },
      deps: fakeDeps(sent)
    })
    expect(summary.totalIterations).toBe(2)
    expect(sent).toEqual(['http://api/users/1?name=ada', 'http://api/users/2?name=alan'])
  })

  it('carries variables set by one request into the next', async () => {
    const sent: string[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('Login', 'http://login', '{"set":{"token":"t-1"}}'), item('Me', 'http://me?t={{token}}')],
      scopes: emptyScopes(),
      options: baseOptions,
      deps: fakeDeps(sent)
    })
    expect(sent).toEqual(['http://login', 'http://me?t=t-1'])
    expect(summary.scopes.environment.token).toBe('t-1')
  })

  it('follows setNextRequest and stops on setNextRequest(null)', async () => {
    const sent: string[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [
        item('A', 'http://a', '{"next":"C"}'),
        item('B', 'http://b', '{}'),
        item('C', 'http://c', '{"next":null}'),
        item('D', 'http://d', '{}')
      ],
      scopes: emptyScopes(),
      options: { ...baseOptions, iterations: 2 },
      deps: fakeDeps(sent)
    })
    expect(sent).toEqual(['http://a', 'http://c'])
    expect(summary.stoppedBecause).toBe('setNextRequest')
  })

  it('stops a setNextRequest loop that never ends', async () => {
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('Poll', 'http://p', '{"next":"Poll"}')],
      scopes: emptyScopes(),
      options: baseOptions,
      deps: fakeDeps([])
    })
    expect(summary.stoppedBecause).toBe('loop')
    expect(summary.requests).toBe(1000)
  })

  it('stops at the first failure when bail is on', async () => {
    const sent: string[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('A', 'http://a', '{}'), item('B', 'http://b', '{"fail":true}'), item('C', 'http://c', '{}')],
      scopes: emptyScopes(),
      options: { ...baseOptions, bail: true },
      deps: fakeDeps(sent)
    })
    expect(sent).toEqual(['http://a', 'http://b'])
    expect(summary).toMatchObject({ stoppedBecause: 'bail', failedRequests: 1 })
    expect(summary.tests).toEqual({ passed: 1, failed: 1, skipped: 0 })
  })

  it('treats network errors as failures and can be cancelled', async () => {
    let stop = false
    const deps: EngineDeps = {
      ...fakeDeps([]),
      send: async () => ({ ok: false, error: { message: 'Connection refused', code: 'ECONNREFUSED' } })
    }
    const steps: RunStep[] = []
    const summary = await runCollection({
      collection: newCollection(),
      items: [item('A', 'http://a'), item('B', 'http://b')],
      scopes: emptyScopes(),
      options: baseOptions,
      deps,
      // Cancel once the first request has finished: B must never be sent.
      onStep: (s) => {
        steps.push(s)
        stop = true
      },
      isCancelled: () => stop
    })
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ passed: false, error: 'Connection refused' })
    expect(summary.stoppedBecause).toBe('cancelled')
  })
})

describe('data files', () => {
  it('parses CSV with quotes, escaped quotes, line breaks and other separators', () => {
    const csv = 'id,name,bio\r\n1,"Lovelace, Ada","said ""hi""\nthen left"\n2,Turing,\n\n'
    expect(parseCsv(csv)).toEqual({
      columns: ['id', 'name', 'bio'],
      rows: [
        { id: '1', name: 'Lovelace, Ada', bio: 'said "hi"\nthen left' },
        { id: '2', name: 'Turing', bio: '' }
      ]
    })
    expect(parseDataFile('a;b\n1;2').rows).toEqual([{ a: '1', b: '2' }])
    expect(parseDataFile('a\tb\n1\t2').rows).toEqual([{ a: '1', b: '2' }])
  })

  it('parses JSON arrays and stringifies values', () => {
    const d = parseDataFile('[{"id": 1, "tags": ["x"], "ok": true}, {"id": 2, "extra": null}]', 'data.json')
    expect(d.columns).toEqual(['id', 'tags', 'ok', 'extra'])
    expect(d.rows).toEqual([{ id: '1', tags: '["x"]', ok: 'true' }, { id: '2', extra: '' }])
  })

  it('explains bad files', () => {
    expect(() => parseDataFile('')).toThrow(/empty/)
    expect(() => parseDataFile('{"a":1}')).toThrow(/array of objects/)
    expect(() => parseDataFile('a,b\n"open')).toThrow(/unterminated/)
  })
})

describe('reports', () => {
  it('writes valid, escaped JUnit and a JSON report without logs or scopes', async () => {
    const steps: RunStep[] = []
    const summary = await runCollection({
      collection: newCollection({ name: 'API <tests>' }),
      items: [item('Get "x" & y', 'http://a', '{"fail":true}')],
      scopes: emptyScopes(),
      options: baseOptions,
      deps: fakeDeps([]),
      onStep: (s) => steps.push(s)
    })
    const junit = toJUnit('API <tests>', summary, steps)
    expect(junit).toContain('<testsuites name="API &lt;tests&gt;" tests="1" failures="1"')
    expect(junit).toContain('<testsuite name="Get &quot;x&quot; &amp; y"')
    expect(junit).toContain('<failure type="AssertionFailure" message="expected failure">')
    const json = toJsonReport('API', summary, steps)
    expect(json.summary).not.toHaveProperty('scopes')
    expect(json.steps[0]).not.toHaveProperty('logs')
  })
})
