import type { ApiRequest, Collection, ExecOptions, Folder } from '../types'
import { executeRequest, type EngineDeps } from './execute'
import type { LogEntry, TestResult } from './scriptTypes'
import type { Scopes, VarMap } from './variables'

// Runs requests in order, once per iteration, carrying variables from one
// request to the next (so a login request can feed the rest of the flow).
// Used by the runner tab and the CLI.

export interface RunItem {
  request: ApiRequest
  /** Folders from the collection root down to the request. */
  parents: Folder[]
}

export interface RunOptions {
  /** Ignored when `data` is given: one iteration per data row. */
  iterations: number
  data?: VarMap[]
  /** Pause between requests, e.g. to stay under a rate limit. */
  delayMs: number
  /** Stop at the first failed request. */
  bail: boolean
  opts: ExecOptions
  scriptTimeoutMs: number
}

export interface RunStep {
  iteration: number
  /** Position of the request in the run's item list. */
  index: number
  requestId: string
  name: string
  method: string
  url: string
  status?: number
  statusText?: string
  timeMs?: number
  sizeBytes?: number
  tests: TestResult[]
  logs: LogEntry[]
  scriptErrors: string[]
  /** Why the request failed to send or produce a response. */
  error?: string
  skipped: boolean
  /** Got a response, no failed tests, no script errors. Skipped steps count as passed. */
  passed: boolean
}

export type StopReason = 'completed' | 'bail' | 'cancelled' | 'setNextRequest' | 'loop'

export interface RunSummary {
  startedAt: number
  finishedAt: number
  totalIterations: number
  /** Iterations that started. */
  iterations: number
  requests: number
  failedRequests: number
  tests: { passed: number; failed: number; skipped: number }
  avgResponseMs: number
  stoppedBecause: StopReason
  /** Human-readable detail for anything but "completed". */
  note?: string
  /** Variables at the end of the run (scripts may have changed them). */
  scopes: Scopes
}

export interface RunInput {
  collection: Collection
  items: RunItem[]
  /** Starting values; the data and local scopes are managed by the run. */
  scopes: Scopes
  options: RunOptions
  deps: EngineDeps
  onStep?: (step: RunStep) => void
  /** Called before each request with what is about to run. */
  onProgress?: (p: { iteration: number; index: number; name: string }) => void
  isCancelled?: () => boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function stepPassed(s: Pick<RunStep, 'tests' | 'error' | 'scriptErrors' | 'skipped' | 'status'>): boolean {
  if (s.skipped) return true
  return s.error === undefined && s.status !== undefined && s.scriptErrors.length === 0 && s.tests.every((t) => t.passed)
}

export async function runCollection(input: RunInput): Promise<RunSummary> {
  const { collection, items, options, deps } = input
  const cancelled = (): boolean => !!input.isCancelled?.()
  const totalIterations = options.data?.length ? options.data.length : Math.max(1, Math.floor(options.iterations))
  let scopes: Scopes = structuredClone(input.scopes)
  const summary: RunSummary = {
    startedAt: Date.now(),
    finishedAt: 0,
    totalIterations,
    iterations: 0,
    requests: 0,
    failedRequests: 0,
    tests: { passed: 0, failed: 0, skipped: 0 },
    avgResponseMs: 0,
    stoppedBecause: 'completed',
    scopes
  }
  let totalTime = 0
  let timed = 0
  // setNextRequest can loop on purpose (polling), but not forever.
  const maxSteps = Math.max(1000, items.length * 100)

  outer: for (let iteration = 0; iteration < totalIterations; iteration++) {
    summary.iterations = iteration + 1
    scopes.data = { ...(options.data?.[iteration] ?? {}) }
    scopes.local = {}
    let steps = 0
    let i = 0
    while (i < items.length) {
      if (cancelled()) {
        summary.stoppedBecause = 'cancelled'
        break outer
      }
      if (++steps > maxSteps) {
        summary.stoppedBecause = 'loop'
        summary.note = `Stopped after ${maxSteps} requests in one iteration; setNextRequest seems to loop forever.`
        break outer
      }
      const item = items[i]
      input.onProgress?.({ iteration, index: i, name: item.request.name })
      const res = await executeRequest(
        {
          request: item.request,
          collection,
          parents: item.parents,
          scopes,
          opts: options.opts,
          scriptTimeoutMs: options.scriptTimeoutMs,
          info: { iteration, iterationCount: totalIterations },
          isCancelled: cancelled
        },
        deps
      )
      if (res.cancelled) {
        summary.stoppedBecause = 'cancelled'
        break outer
      }
      scopes = res.scopes
      // A script may not change which data row is current.
      scopes.data = { ...(options.data?.[iteration] ?? {}) }

      const response = res.result?.ok ? res.result.response : undefined
      const step: RunStep = {
        iteration,
        index: i,
        requestId: item.request.id,
        name: item.request.name,
        method: res.prepared?.method ?? item.request.method,
        url: res.prepared?.url ?? item.request.url,
        status: response?.status,
        statusText: response?.statusText,
        timeMs: response ? Math.round(response.timings.total) : undefined,
        sizeBytes: response?.bodySize,
        tests: res.tests,
        logs: res.logs,
        scriptErrors: res.scriptErrors,
        error: res.error ?? (res.result && !res.result.ok ? res.result.error.message : undefined),
        skipped: !!res.skipped,
        passed: false
      }
      step.passed = stepPassed(step)

      summary.requests++
      if (!step.passed) summary.failedRequests++
      for (const t of step.tests) {
        if (t.skipped) summary.tests.skipped++
        else if (t.passed) summary.tests.passed++
        else summary.tests.failed++
      }
      if (step.timeMs !== undefined) {
        totalTime += step.timeMs
        timed++
      }
      input.onStep?.(step)

      if (!step.passed && options.bail) {
        summary.stoppedBecause = 'bail'
        summary.note = `Stopped at the first failure: “${step.name}”.`
        break outer
      }
      if (res.nextRequest === null) {
        summary.stoppedBecause = 'setNextRequest'
        summary.note = `“${step.name}” stopped the run with setNextRequest(null).`
        break outer
      }
      if (typeof res.nextRequest === 'string') {
        const target = items.findIndex((it) => it.request.name === res.nextRequest)
        if (target === -1) {
          summary.stoppedBecause = 'setNextRequest'
          summary.note = `setNextRequest("${res.nextRequest}") names a request that isn’t part of this run.`
          break outer
        }
        i = target
      } else i++

      if (options.delayMs > 0 && i < items.length && !cancelled()) await sleep(options.delayMs)
    }
  }

  summary.finishedAt = Date.now()
  summary.avgResponseMs = timed ? Math.round(totalTime / timed) : 0
  summary.scopes = scopes
  return summary
}
