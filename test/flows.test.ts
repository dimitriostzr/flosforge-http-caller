import { describe, expect, it } from 'vitest'
import { kv, newCapture, newCollection, newRequest, uid, variable } from '@shared/model'
import type { ExecResult, Flow, FlowCondition, FlowStep } from '@shared/types'
import type { EngineDeps } from '@shared/engine/execute'
import { describeCondition, evaluateCondition, runFlow, variablesBefore, type FlowStepResult } from '@shared/engine/flowRun'
import { emptyScopes } from '@shared/engine/variables'
import type { ScriptJob, ScriptOutcome } from '@shared/engine/scriptTypes'

const json = (status: number, value: unknown, headers: [string, string][] = []): ExecResult => ({
  ok: true,
  response: {
    status,
    statusText: '',
    httpVersion: '1.1',
    headers: [['Content-Type', 'application/json'], ...headers],
    body: new TextEncoder().encode(JSON.stringify(value)),
    bodySize: 10,
    headersSize: 10,
    timings: { firstByte: 1, download: 1, total: 5 },
    url: 'http://x',
    redirects: [],
    requestHeaders: []
  }
})

/** A fake API: /login gives a token, /job is pending twice then done, /fail is a 500; it records every URL. */
function api(sent: string[]): EngineDeps {
  let jobPolls = 0
  return {
    send: async (req) => {
      sent.push(req.url)
      if (req.url.endsWith('/login')) return json(200, { token: 'T1', user: { id: 7 } })
      if (req.url.includes('/job')) return json(200, { state: ++jobPolls >= 3 ? 'done' : 'pending' })
      if (req.url.endsWith('/fail')) return json(500, { error: 'boom' })
      return json(200, { ok: true })
    },
    runScripts: async (job: ScriptJob): Promise<ScriptOutcome> => ({ scopes: structuredClone(job.scopes), request: job.request, tests: [], logs: [] })
  }
}

const auth = newCollection({ name: 'Auth', variables: [variable('base', 'http://auth')] })
const login = newRequest({ name: 'Login', url: '{{base}}/login', captures: [newCapture({ variable: 'token', path: '$.token' })] })
auth.items.push(login)
const shop = newCollection({ name: 'Shop', variables: [variable('base', 'http://shop')] })
const me = newRequest({ name: 'Me', url: '{{base}}/users/{{userId}}?t={{token}}' })
const job = newRequest({ name: 'Job', url: '{{base}}/job' })
const fail = newRequest({ name: 'Fail', url: '{{base}}/fail' })
shop.items.push(me, job, fail)
const collections = [auth, shop]

const step = (request: { id: string }, collection: { id: string }, extra: Partial<FlowStep> = {}): FlowStep => ({
  id: uid(),
  kind: 'request',
  enabled: true,
  collectionId: collection.id,
  requestId: request.id,
  ...extra
})
const flow = (steps: FlowStep[]): Flow => ({ id: uid(), name: 'F', description: '', steps, createdAt: 0, updatedAt: 0 })
const opts = { timeoutMs: 0, followRedirects: true, maxRedirects: 5, verifySsl: true, useCookieJar: false }

async function run(steps: FlowStep[], sent: string[] = []) {
  const results: FlowStepResult[] = []
  const summary = await runFlow({
    flow: flow(steps),
    collections,
    scopes: emptyScopes(),
    opts,
    scriptTimeoutMs: 1000,
    deps: api(sent),
    onStep: (r) => results.push(r)
  })
  return { summary, results, sent }
}

describe('flows', () => {
  it('chains steps across collections, each with its own collection variables', async () => {
    const { summary, sent } = await run([
      step(login, auth, { captures: [newCapture({ variable: 'userId', path: '$.user.id', scope: 'local' })] }),
      step(me, shop)
    ])
    expect(sent).toEqual(['http://auth/login', 'http://shop/users/7?t=T1'])
    expect(summary).toMatchObject({ steps: 2, failed: 0, stoppedBecause: 'completed' })
    expect(summary.scopes.environment.token).toBe('T1')
    // Run-only values are kept to the end of the flow, but no further.
    expect(summary.scopes.local.userId).toBe('7')
    expect(summary.collections[auth.id].base).toBe('http://auth')
  })

  it('gives a step its own values, for that step only', async () => {
    const { sent } = await run([step(me, shop, { variables: [kv('userId', '{{base}}-x'), kv('token', 'override')] }), step(me, shop)])
    expect(sent).toEqual(['http://shop/users/http://shop-x?t=override', 'http://shop/users/{{userId}}?t={{token}}'])
  })

  it('skips steps whose condition doesn’t hold, and turned-off steps', async () => {
    const isAdmin: FlowCondition = { source: 'variable', path: 'role', op: 'equals', value: 'admin' }
    const { results, sent } = await run([step(me, shop, { runIf: isAdmin }), step(me, shop, { enabled: false }), step(login, auth)])
    expect(results.map((r) => r.skipped)).toEqual(['Skipped: {{role}} equals admin doesn’t hold', 'Turned off', undefined])
    expect(results.every((r) => r.passed)).toBe(true)
    expect(sent).toEqual(['http://auth/login'])
  })

  it('repeats a step until its condition holds', async () => {
    const until: FlowCondition = { source: 'body', path: '$.state', op: 'equals', value: 'done' }
    const { results, sent } = await run([step(job, shop, { repeatUntil: { condition: until, times: 5, delayMs: 0 } })])
    expect(sent).toHaveLength(3)
    expect(results[0]).toMatchObject({ attempts: 3, passed: true })
  })

  it('fails a repeat that never gets there', async () => {
    const until: FlowCondition = { source: 'body', path: '$.state', op: 'equals', value: 'never' }
    const { results, summary } = await run([step(job, shop, { repeatUntil: { condition: until, times: 2, delayMs: 0 } }), step(me, shop)])
    expect(results[0]).toMatchObject({ attempts: 2, passed: false, error: 'Still not $.state equals never after 2 tries' })
    expect(summary).toMatchObject({ stoppedBecause: 'failed', steps: 1 })
  })

  it('stops at a failed check unless the step says to carry on', async () => {
    const ok2xx: FlowCondition = { source: 'status', path: '', op: 'matches', value: '^2' }
    const stopped = await run([step(fail, shop, { expect: ok2xx }), step(me, shop)])
    expect(stopped.results[0]).toMatchObject({ passed: false, error: 'Check failed: status matches pattern ^2' })
    expect(stopped.summary).toMatchObject({ stoppedBecause: 'failed', failed: 1, note: 'Stopped at step 1, “Fail”.' })

    const carried = await run([step(fail, shop, { expect: ok2xx, onFailure: 'continue' }), step(me, shop)])
    expect(carried.summary).toMatchObject({ stoppedBecause: 'completed', steps: 2, failed: 1 })
  })

  it('waits on delay steps and reports a deleted request', async () => {
    const { results, summary } = await run([
      { id: uid(), kind: 'delay', enabled: true, delayMs: 20 },
      { id: uid(), kind: 'request', enabled: true, collectionId: shop.id, requestId: 'gone' }
    ])
    expect(results[0].timeMs).toBeGreaterThanOrEqual(15)
    expect(results[1]).toMatchObject({ passed: false, error: expect.stringMatching(/was deleted/) })
    expect(summary.stoppedBecause).toBe('failed')
  })

  it('stops when cancelled', async () => {
    let n = 0
    const summary = await runFlow({
      flow: flow([step(me, shop), step(me, shop), step(me, shop)]),
      collections,
      scopes: emptyScopes(),
      opts,
      scriptTimeoutMs: 1000,
      deps: api([]),
      onStep: () => n++,
      isCancelled: () => n >= 1
    })
    expect(summary).toMatchObject({ stoppedBecause: 'cancelled', steps: 1 })
  })
})

describe('conditions', () => {
  const scopes = { ...emptyScopes(), environment: { n: '5', name: 'Ada' } }
  const res = { status: 404, headers: [['X-Id', 'abc'] as [string, string]], body: '{"items":[1,2]}' }
  const c = (source: FlowCondition['source'], path: string, op: FlowCondition['op'], value = ''): FlowCondition => ({ source, path, op, value })

  it('checks variables and responses', () => {
    expect(evaluateCondition(c('variable', 'n', 'greater', '3'), scopes)).toBe(true)
    expect(evaluateCondition(c('variable', '{{n}}', 'less', '3'), scopes)).toBe(false)
    expect(evaluateCondition(c('variable', 'name', 'equals', '{{name}}'), scopes)).toBe(true)
    expect(evaluateCondition(c('variable', 'nope', 'exists'), scopes)).toBe(false)
    expect(evaluateCondition(c('variable', 'nope', 'not-exists'), scopes)).toBe(true)
    expect(evaluateCondition(c('status', '', 'equals', '404'), scopes, res)).toBe(true)
    expect(evaluateCondition(c('header', 'x-id', 'contains', 'b'), scopes, res)).toBe(true)
    expect(evaluateCondition(c('body', '$.items[-1]', 'equals', '2'), scopes, res)).toBe(true)
    expect(evaluateCondition(c('body', '$.missing', 'not-exists'), scopes, res)).toBe(true)
    expect(evaluateCondition(c('variable', 'name', 'matches', '('), scopes)).toBe(false)
    expect(evaluateCondition(c('variable', 'name', 'greater', '1'), scopes)).toBe(false)
  })

  it('reads as a sentence', () => {
    expect(describeCondition(c('body', '$.state', 'not-equals', 'done'))).toBe('$.state doesn’t equal done')
    expect(describeCondition(c('variable', 'token', 'exists'))).toBe('{{token}} exists')
  })
})

describe('flows in backups', () => {
  it('travel with the collections and follow their requests to new ids', async () => {
    const { exportNative, importText } = await import('@shared/importers')
    const f = flow([step(login, auth), step(me, shop, { variables: [kv('userId', '1')] }), { id: uid(), kind: 'delay', enabled: true, delayMs: 5 }])
    const back = importText(JSON.stringify(exportNative(collections, [], [f])))
    expect(back.flows).toHaveLength(1)
    const [imported] = back.flows!
    expect(imported.id).not.toBe(f.id)
    const [a, b] = imported.steps
    const shopCopy = back.collections.find((c) => c.name === 'Shop')!
    expect(b.collectionId).toBe(shopCopy.id)
    expect(b.collectionId).not.toBe(shop.id)
    expect(shopCopy.items.find((it) => it.id === b.requestId)?.name).toBe('Me')
    expect(back.collections.find((c) => c.id === a.collectionId)?.name).toBe('Auth')
    expect(b.variables?.[0]).toMatchObject({ key: 'userId', value: '1' })
    expect(imported.steps[2]).toMatchObject({ kind: 'delay', delayMs: 5 })
  })
})

describe('variables from earlier steps', () => {
  it('lists what earlier steps capture or set in scripts, not their step-only values', () => {
    const scripted = newRequest({ name: 'Scripted', url: 'x', scripts: { preRequest: '', test: "pm.environment.set('orderId', 1)" } })
    shop.items.push(scripted)
    const f = flow([
      step(login, auth, { captures: [newCapture({ variable: 'userId', path: '$.user.id' })], variables: [kv('onlyHere', '1')] }),
      step(scripted, shop),
      step(me, shop, { enabled: false, captures: [newCapture({ variable: 'ignored', path: '$.x' })] }),
      step(me, shop)
    ])
    expect(variablesBefore(f, 0, collections)).toEqual([])
    expect(variablesBefore(f, 1, collections).map((v) => [v.name, v.stepIndex, v.how])).toEqual([
      ['token', 0, 'capture'],
      ['userId', 0, 'capture']
    ])
    expect(variablesBefore(f, 3, collections).map((v) => `${v.name}@${v.stepIndex + 1}`)).toEqual(['token@1', 'userId@1', 'orderId@2'])
    shop.items.pop()
  })
})
