import { findPath } from '../tree'
import type { ApiRequest, Collection, ExecOptions, Flow, FlowCondition, FlowStep, Folder } from '../types'
import { extractCapture, type CaptureResponse, type CaptureResult } from './captures'
import { decodeBody } from './body'
import { stepPassed } from './collectionRun'
import { executeRequest, type EngineDeps } from './execute'
import type { LogEntry, TestResult } from './scriptTypes'
import { lookup, resolve, toMap, type Scopes, type VarMap } from './variables'
import { scriptVariables } from '../variableUsage'

// Runs a flow: library requests in order, each with its own collection's
// variables, carrying everything set along the way to the next step. Steps
// can be conditional, repeat until something holds (polling), add their own
// checks and captures, and either stop the flow or let it go on when they fail.

export interface FlowStepResult {
  stepId: string
  index: number
  kind: FlowStep['kind']
  name: string
  method?: string
  url?: string
  status?: number
  statusText?: string
  timeMs?: number
  sizeBytes?: number
  /** How many times it was sent (more than one with "repeat until"). */
  attempts: number
  tests: TestResult[]
  logs: LogEntry[]
  scriptErrors: string[]
  captures: CaptureResult[]
  error?: string
  /** Why it didn't run (turned off, its condition didn't hold). */
  skipped?: string
  passed: boolean
  /** The last response, for showing and for filling captures in (body cut at 1 MB). */
  response?: CaptureResponse
}

export type FlowStopReason = 'completed' | 'failed' | 'cancelled'

export interface FlowSummary {
  startedAt: number
  finishedAt: number
  steps: number
  failed: number
  stoppedBecause: FlowStopReason
  note?: string
  /** Globals, environment and run-only values at the end. */
  scopes: Scopes
  /** Each collection's variables at the end, by collection id (only collections the flow used). */
  collections: Record<string, VarMap>
}

export interface FlowInput {
  flow: Flow
  collections: Collection[]
  /** Starting globals and environment; the collection scope is set per step. */
  scopes: Scopes
  opts: ExecOptions
  scriptTimeoutMs: number
  environmentActive?: boolean
  deps: EngineDeps
  onStep?: (r: FlowStepResult) => void
  onProgress?: (p: { index: number; name: string; attempt: number }) => void
  isCancelled?: () => boolean
}

const MAX_BODY = 1024 * 1024

// ---------------------------------------------------------------------------
// Conditions

export const CONDITION_OPS: { id: FlowCondition['op']; label: string; needsValue: boolean }[] = [
  { id: 'equals', label: 'equals', needsValue: true },
  { id: 'not-equals', label: 'doesn’t equal', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'not-contains', label: 'doesn’t contain', needsValue: true },
  { id: 'matches', label: 'matches pattern', needsValue: true },
  { id: 'greater', label: 'is greater than', needsValue: true },
  { id: 'less', label: 'is less than', needsValue: true },
  { id: 'exists', label: 'exists', needsValue: false },
  { id: 'not-exists', label: 'doesn’t exist', needsValue: false }
]

export function describeCondition(c: FlowCondition): string {
  const what =
    c.source === 'variable'
      ? `{{${c.path}}}`
      : c.source === 'status'
        ? 'status'
        : c.source === 'body'
          ? c.path || 'body'
          : `${c.source} ${c.path}`
  const op = CONDITION_OPS.find((o) => o.id === c.op)
  return `${what} ${op?.label ?? c.op}${op?.needsValue ? ` ${c.value}` : ''}`
}

/** Whether `c` holds. Response sources need `res`; without one they don't exist. */
export function evaluateCondition(c: FlowCondition, scopes: Scopes, res?: CaptureResponse): boolean {
  let actual: string | undefined
  if (c.source === 'variable') actual = lookup(scopes, c.path.trim().replace(/^\{\{\s*|\s*\}\}$/g, ''))?.value
  else if (res) {
    const got = extractCapture({ source: c.source, path: c.path, regex: '' }, res)
    actual = 'value' in got ? got.value : undefined
  }
  const expected = resolve(c.value, scopes)
  switch (c.op) {
    case 'exists':
      return actual !== undefined
    case 'not-exists':
      return actual === undefined
    case 'equals':
      return actual === expected
    case 'not-equals':
      return actual !== expected
    case 'contains':
      return actual !== undefined && actual.includes(expected)
    case 'not-contains':
      return actual === undefined || !actual.includes(expected)
    case 'matches':
      try {
        return actual !== undefined && new RegExp(expected).test(actual)
      } catch {
        return false
      }
    case 'greater':
    case 'less': {
      const a = Number(actual)
      const b = Number(expected)
      if (actual === undefined || actual.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) return false
      return c.op === 'greater' ? a > b : a < b
    }
  }
}

// ---------------------------------------------------------------------------

export function stepRequest(step: FlowStep, collections: Collection[]): { request: ApiRequest; parents: Folder[]; collection: Collection } | null {
  const collection = collections.find((c) => c.id === step.collectionId)
  const path = collection && step.requestId ? findPath(collection, step.requestId) : null
  if (!collection || path?.item.kind !== 'request') return null
  return { request: path.item, parents: path.parents, collection }
}

const sleep = (ms: number, cancelled: () => boolean): Promise<void> =>
  new Promise((done) => {
    const end = Date.now() + ms
    const tick = (): void => (cancelled() || Date.now() >= end ? done() : void setTimeout(tick, Math.min(100, end - Date.now())))
    tick()
  })

export async function runFlow(input: FlowInput): Promise<FlowSummary> {
  const { flow, collections, deps } = input
  const cancelled = (): boolean => !!input.isCancelled?.()
  let scopes: Scopes = { ...structuredClone(input.scopes), data: {}, local: {} }
  const collectionVars: Record<string, VarMap> = {}
  const summary: FlowSummary = {
    startedAt: Date.now(),
    finishedAt: 0,
    steps: 0,
    failed: 0,
    stoppedBecause: 'completed',
    scopes,
    collections: collectionVars
  }
  const report = (r: FlowStepResult): void => {
    summary.steps++
    if (!r.passed) summary.failed++
    input.onStep?.(r)
  }

  for (let index = 0; index < flow.steps.length; index++) {
    if (cancelled()) {
      summary.stoppedBecause = 'cancelled'
      break
    }
    const step = flow.steps[index]
    const base = { stepId: step.id, index, kind: step.kind, attempts: 0, tests: [], logs: [], scriptErrors: [], captures: [] }

    if (step.kind === 'delay') {
      const ms = Math.max(0, step.delayMs ?? 0)
      if (!step.enabled) {
        report({ ...base, name: `Wait ${ms} ms`, skipped: 'Turned off', passed: true })
        continue
      }
      input.onProgress?.({ index, name: `Wait ${ms} ms`, attempt: 1 })
      const t0 = Date.now()
      await sleep(ms, cancelled)
      report({ ...base, name: `Wait ${ms} ms`, timeMs: Date.now() - t0, passed: true })
      continue
    }

    const target = stepRequest(step, collections)
    if (!target) {
      report({ ...base, name: 'Missing request', error: 'The request this step runs was deleted or moved to another workspace', passed: false })
      if (step.onFailure !== 'continue') {
        summary.stoppedBecause = 'failed'
        summary.note = `Step ${index + 1} has no request.`
        break
      }
      continue
    }
    const { request, parents, collection } = target
    if (!step.enabled) {
      report({ ...base, name: request.name, method: request.method, skipped: 'Turned off', passed: true })
      continue
    }

    collectionVars[collection.id] ??= toMap(collection.variables)
    scopes.collection = collectionVars[collection.id]
    if (step.runIf && !evaluateCondition(step.runIf, scopes)) {
      report({ ...base, name: request.name, method: request.method, skipped: `Skipped: ${describeCondition(step.runIf)} doesn’t hold`, passed: true })
      continue
    }

    // The step's own values sit in the data scope: above the environment, below run-only values, gone after the step.
    const stepVars: VarMap = {}
    for (const v of step.variables ?? []) if (v.enabled && v.key.trim()) stepVars[v.key.trim()] = resolve(v.value, scopes)
    const toRun: ApiRequest = step.captures?.length ? { ...request, captures: [...(request.captures ?? []), ...step.captures] } : request

    const times = step.repeatUntil ? Math.max(1, Math.floor(step.repeatUntil.times)) : 1
    let result: FlowStepResult | undefined
    let untilMet = !step.repeatUntil
    for (let attempt = 1; attempt <= times; attempt++) {
      input.onProgress?.({ index, name: request.name, attempt })
      const res = await executeRequest(
        {
          request: toRun,
          collection,
          parents,
          scopes: { ...scopes, data: stepVars },
          opts: input.opts,
          scriptTimeoutMs: input.scriptTimeoutMs,
          info: { iteration: 0, iterationCount: 1 },
          isCancelled: cancelled,
          environmentActive: input.environmentActive
        },
        deps
      )
      if (res.cancelled) break
      scopes = { ...res.scopes, data: {} }
      collectionVars[collection.id] = scopes.collection

      const http = res.result?.ok ? res.result.response : undefined
      const response: CaptureResponse | undefined = http
        ? { status: http.status, headers: http.headers, body: decodeBody(http.body, http.headers).slice(0, MAX_BODY) }
        : undefined
      result = {
        ...base,
        name: request.name,
        method: res.prepared?.method ?? request.method,
        url: res.prepared?.url ?? request.url,
        status: http?.status,
        statusText: http?.statusText,
        timeMs: http ? Math.round(http.timings.total) : undefined,
        sizeBytes: http?.bodySize,
        attempts: attempt,
        tests: res.tests,
        logs: res.logs,
        scriptErrors: res.scriptErrors,
        captures: res.captures,
        error: res.error ?? (res.result && !res.result.ok ? res.result.error.message : undefined),
        ...(res.skipped ? { skipped: 'Skipped by its pre-request script' } : {}),
        passed: false,
        response
      }
      if (!step.repeatUntil || !response) break
      untilMet = evaluateCondition(step.repeatUntil.condition, scopes, response)
      if (untilMet || attempt === times || cancelled()) break
      await sleep(Math.max(0, step.repeatUntil.delayMs), cancelled)
    }
    if (!result || cancelled()) {
      summary.stoppedBecause = 'cancelled'
      break
    }

    let passed = stepPassed({ ...result, skipped: !!result.skipped })
    if (passed && step.repeatUntil && !untilMet) {
      passed = false
      result.error = `Still not ${describeCondition(step.repeatUntil.condition)} after ${result.attempts} tr${result.attempts === 1 ? 'y' : 'ies'}`
    }
    if (passed && step.expect && !result.skipped && !evaluateCondition(step.expect, scopes, result.response)) {
      passed = false
      result.error = `Check failed: ${describeCondition(step.expect)}`
    }
    result.passed = passed
    report(result)
    if (!passed && step.onFailure !== 'continue') {
      summary.stoppedBecause = 'failed'
      summary.note = `Stopped at step ${index + 1}, “${result.name}”.`
      break
    }
  }

  summary.finishedAt = Date.now()
  summary.scopes = scopes
  return summary
}

export interface EarlierVariable {
  name: string
  /** Zero-based index of the step that sets it (the last one, if several do). */
  stepIndex: number
  stepName: string
  how: 'capture' | 'script'
}

/**
 * Variables the steps before `index` set when they run: their captures (the
 * request's own and the step's) and what their scripts set. A step's own
 * values aren't listed: they last for that step only.
 */
export function variablesBefore(flow: Flow, index: number, collections: Collection[]): EarlierVariable[] {
  const found = new Map<string, EarlierVariable>()
  flow.steps.slice(0, index).forEach((step, i) => {
    if (!step.enabled || step.kind !== 'request') return
    const target = stepRequest(step, collections)
    if (!target) return
    const set = (name: string, how: EarlierVariable['how']): void => {
      const n = name.trim()
      if (n) found.set(n, { name: n, stepIndex: i, stepName: target.request.name, how })
    }
    for (const c of [...(target.request.captures ?? []), ...(step.captures ?? [])]) if (c.enabled) set(c.variable, 'capture')
    const scripts = [...(target.parents.flatMap((p) => [p.scripts.preRequest, p.scripts.test])), target.request.scripts.preRequest, target.request.scripts.test]
    for (const code of scripts) for (const name of scriptVariables(code).sets) set(name, 'script')
  })
  return [...found.values()]
}
