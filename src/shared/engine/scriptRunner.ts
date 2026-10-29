import { uid } from '../model'
import type { ExecOptions, ExecResult, PreparedRequest } from '../types'
import { decodeBody } from './body'
import type { LogEntry, ScriptJob, ScriptOutcome, ScriptResponse, SendRequestSpec, TestResult, WorkerInbound, WorkerOutbound } from './scriptTypes'
import type { Scopes, VarMap } from './variables'

// Drives the script sandbox the same way everywhere. The app runs it in a Web
// Worker, the CLI in a Node worker thread; both are wrapped as a WorkerLike.

export interface WorkerLike {
  postMessage(msg: WorkerInbound): void
  onMessage(cb: (msg: WorkerOutbound) => void): void
  onError(cb: (message: string) => void): void
  terminate(): void
}

export interface ScriptHost {
  /** Starts a fresh sandbox; one per job, so no state leaks between runs. */
  spawn(): WorkerLike
  /** Sends pm.sendRequest() calls. */
  send(req: PreparedRequest, opts: ExecOptions): Promise<ExecResult>
}

export type RunScripts = (job: ScriptJob, timeoutMs: number, opts: ExecOptions) => Promise<ScriptOutcome>

/** True when there is at least one non-empty script to run. */
export const hasScripts = (job: Pick<ScriptJob, 'scripts'>): boolean => job.scripts.some((s) => s.code.trim())

/**
 * Returns a function that runs a script job and resolves with its outcome. The
 * sandbox is terminated if it stays busy longer than `timeoutMs` without waiting
 * on a pm.sendRequest call, so an infinite loop can't hang a send or a run.
 */
export function createScriptRunner(host: ScriptHost): RunScripts {
  return (job, timeoutMs, opts) =>
    new Promise((resolve) => {
      const worker = host.spawn()
      let inFlight = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false

      const finish = (outcome: ScriptOutcome): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        worker.terminate()
        resolve(outcome)
      }
      const fail = (error: string): void =>
        finish({ scopes: job.scopes, request: job.request, tests: [], logs: [{ level: 'error', message: error, source: 'sandbox' }], error })

      const armTimer = (): void => {
        clearTimeout(timer)
        if (inFlight === 0 && timeoutMs > 0) timer = setTimeout(() => fail(`Script timed out after ${timeoutMs}ms`), timeoutMs)
      }

      worker.onMessage(async (msg) => {
        if (msg.type === 'done') return finish(checkedOutcome(msg.outcome, job))
        if (msg.type === 'sendRequest') {
          inFlight++
          clearTimeout(timer)
          const reply = await scriptSendRequest(host, msg.spec, opts)
          inFlight--
          if (finished) return
          worker.postMessage({ type: 'sendRequestResult', id: msg.id, ...reply })
          armTimer()
        }
      })
      worker.onError((message) => fail(`Script sandbox error: ${message}`))

      worker.postMessage({ type: 'run', job })
      armTimer()
    })
}

// --- Checking what the sandbox sends back ---------------------------------------------------

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A variable map with string values only; anything else falls back to what the script started with. */
function varMap(v: unknown, fallback: VarMap): VarMap {
  if (!isObj(v)) return fallback
  const out: VarMap = {}
  for (const [k, val] of Object.entries(v)) if (isStr(val)) out[k] = val
  return out
}

/**
 * The outcome is posted by the sandbox, so a script could forge it. Keeps only
 * well-formed data; the request itself is merged field by field by the executor,
 * which never takes file paths from a script.
 */
function checkedOutcome(o: unknown, job: ScriptJob): ScriptOutcome {
  if (!isObj(o)) return { scopes: job.scopes, request: job.request, tests: [], logs: [], error: 'The script sandbox sent an invalid result' }
  const s = isObj(o.scopes) ? o.scopes : {}
  const scopes: Scopes = {
    globals: varMap(s.globals, job.scopes.globals),
    collection: varMap(s.collection, job.scopes.collection),
    environment: varMap(s.environment, job.scopes.environment),
    data: varMap(s.data, job.scopes.data ?? {}),
    local: varMap(s.local, job.scopes.local)
  }
  const tests: TestResult[] = (Array.isArray(o.tests) ? o.tests : [])
    .filter((t): t is Record<string, unknown> => isObj(t) && isStr(t.name))
    .map((t) => ({
      name: t.name as string,
      passed: t.passed === true,
      ...(t.skipped === true ? { skipped: true } : {}),
      ...(isStr(t.error) ? { error: t.error } : {})
    }))
  const levels = new Set(['log', 'info', 'warn', 'error', 'debug'])
  const logs: LogEntry[] = (Array.isArray(o.logs) ? o.logs : [])
    .filter((l): l is Record<string, unknown> => isObj(l) && isStr(l.message))
    .map((l) => ({
      level: (isStr(l.level) && levels.has(l.level) ? l.level : 'log') as LogEntry['level'],
      message: l.message as string,
      source: isStr(l.source) ? l.source : ''
    }))
  return {
    scopes,
    request: (isObj(o.request) ? o.request : job.request) as ScriptOutcome['request'],
    tests,
    logs,
    ...(isStr(o.error) ? { error: o.error } : {}),
    ...(o.skipRequest === true ? { skipRequest: true } : {}),
    ...(o.nextRequest === null || isStr(o.nextRequest) ? { nextRequest: o.nextRequest } : {})
  }
}

async function scriptSendRequest(
  host: ScriptHost,
  spec: SendRequestSpec,
  opts: ExecOptions
): Promise<{ error?: string; response?: ScriptResponse }> {
  const headers = [...spec.headers]
  let body: { type: 'none' } | { type: 'text'; text: string } = { type: 'none' }
  if (spec.body?.mode === 'raw') body = { type: 'text', text: spec.body.raw }
  else if (spec.body?.mode === 'urlencoded') {
    body = {
      type: 'text',
      text: spec.body.pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    }
    if (!headers.some(([k]) => k.toLowerCase() === 'content-type'))
      headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
  }
  const result = await host.send({ execId: uid(), method: spec.method, url: spec.url, headers, body }, opts)
  if (!result.ok) return { error: result.error.message }
  const r = result.response
  return {
    response: {
      code: r.status,
      status: r.statusText,
      headers: r.headers,
      body: decodeBody(r.body, r.headers),
      responseTime: Math.round(r.timings.total),
      responseSize: r.bodySize
    }
  }
}
