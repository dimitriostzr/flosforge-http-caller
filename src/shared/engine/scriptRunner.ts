import { uid } from '../model'
import type { ExecOptions, ExecResult, PreparedRequest } from '../types'
import { decodeBody } from './body'
import type { ScriptJob, ScriptOutcome, ScriptResponse, SendRequestSpec, WorkerInbound, WorkerOutbound } from './scriptTypes'

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
        if (msg.type === 'done') return finish(msg.outcome)
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
