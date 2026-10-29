import { create } from 'zustand'
import type { ExecProgress, ExecResult, PreparedRequest } from '@shared/types'
import type { LogEntry, TestResult } from '@shared/engine/scriptTypes'
import type { CaptureResult } from '@shared/engine/captures'
import type { VarMap } from '@shared/engine/variables'
import type { RunStep, RunSummary } from '@shared/engine/collectionRun'
import type { FlowStepResult, FlowSummary } from '@shared/engine/flowRun'

/** A flow run shown in its tab. In memory only; the last result of each step stays until the next run. */
export interface FlowRunState {
  status: 'running' | 'done'
  startedAt: number
  /** This run's results, by step id. */
  results: Record<string, FlowStepResult>
  /** The run before's, shown dimmed for steps that haven't run again yet. */
  previous: Record<string, FlowStepResult>
  progress?: { index: number; name: string; attempt: number }
  summary?: FlowSummary
  cancelRequested?: boolean
}

/** A collection run shown in a runner tab. In memory only. */
export interface RunnerRun {
  status: 'running' | 'done'
  startedAt: number
  totalIterations: number
  steps: RunStep[]
  progress?: { iteration: number; index: number; name: string }
  summary?: RunSummary
  cancelRequested?: boolean
}

/** Result of one send, shown in the response panel. Kept in memory only. */
export interface RunResult {
  at: number
  prepared?: PreparedRequest
  result?: ExecResult
  /** Failure before the request went out (bad variables, pre-request script asked to skip, …). */
  error?: string
  tests: TestResult[]
  logs: LogEntry[]
  scriptErrors: string[]
  captures?: CaptureResult[]
}

/** A response still arriving: shown live (event streams, slow bodies) until the result replaces it. */
export interface LiveResponse {
  execId: string
  head?: Extract<ExecProgress, { type: 'head' }>
  text: string
  bytes: number
  /** When the head arrived. */
  startedAt: number
  /** The user pressed Stop; the response so far is on its way. */
  stopping?: boolean
}

interface RuntimeState {
  results: Record<string, RunResult>
  /** tabId → the response arriving for its in-flight request. */
  live: Record<string, LiveResponse>
  /** tabId → execId of the in-flight request. */
  sending: Record<string, string>
  /**
   * Temporary values per tab: used when sending (above the environment, like
   * local variables in other API clients) but never saved anywhere.
   */
  tabVars: Record<string, VarMap>
  runs: Record<string, RunnerRun>
  /** By flow id. */
  flowRuns: Record<string, FlowRunState>
  setFlowRun(flowId: string, update: (r: FlowRunState | undefined) => FlowRunState | undefined): void
  setRun(tabId: string, update: (r: RunnerRun | undefined) => RunnerRun | undefined): void
  setResult(tabId: string, r: RunResult): void
  setSending(tabId: string, execId: string | null): void
  applyProgress(execId: string, p: ExecProgress): void
  markStopping(tabId: string): void
  setTabVar(tabId: string, name: string, value: string | null): void
  clearTabVars(tabId: string): void
}

const without = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

export const useRuntime = create<RuntimeState>()((set) => ({
  results: {},
  live: {},
  sending: {},
  tabVars: {},
  runs: {},
  flowRuns: {},
  setFlowRun: (flowId, update) =>
    set((s) => {
      const flowRuns = { ...s.flowRuns }
      const next = update(s.flowRuns[flowId])
      if (next) flowRuns[flowId] = next
      else delete flowRuns[flowId]
      return { flowRuns }
    }),
  setRun: (tabId, update) =>
    set((s) => {
      const runs = { ...s.runs }
      const next = update(s.runs[tabId])
      if (next) runs[tabId] = next
      else delete runs[tabId]
      return { runs }
    }),
  setTabVar: (tabId, name, value) =>
    set((s) => {
      const vars = { ...s.tabVars[tabId] }
      if (value === null) delete vars[name]
      else vars[name] = value
      return { tabVars: { ...s.tabVars, [tabId]: vars } }
    }),
  clearTabVars: (tabId) =>
    set((s) => {
      const tabVars = { ...s.tabVars }
      delete tabVars[tabId]
      return { tabVars }
    }),
  setResult: (tabId, r) => set((s) => ({ results: { ...s.results, [tabId]: r }, live: without(s.live, tabId) })),
  setSending: (tabId, execId) =>
    set((s) => {
      const sending = { ...s.sending }
      if (execId) sending[tabId] = execId
      else delete sending[tabId]
      return { sending, live: without(s.live, tabId) }
    }),
  applyProgress: (execId, p) =>
    set((s) => {
      // Only a tab's own request shows live; pm.sendRequest and runner requests aren't tracked.
      const tabId = Object.keys(s.sending).find((id) => s.sending[id] === execId)
      if (!tabId) return {}
      const cur = s.live[tabId]?.execId === execId ? s.live[tabId] : { execId, text: '', bytes: 0, startedAt: Date.now() }
      const next: LiveResponse =
        p.type === 'head' ? { ...cur, head: p, startedAt: Date.now() } : { ...cur, text: cur.text + p.text, bytes: p.bytes }
      return { live: { ...s.live, [tabId]: next } }
    }),
  markStopping: (tabId) =>
    set((s) => (s.live[tabId] ? { live: { ...s.live, [tabId]: { ...s.live[tabId], stopping: true } } } : {}))
}))
