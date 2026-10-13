import type { KeyValue, RequestBody } from '../types'
import type { Scopes } from './variables'

// Messages exchanged between the renderer and the script sandbox worker.

export interface ScriptRequest {
  id: string
  name: string
  method: string
  url: string
  headers: Pick<KeyValue, 'key' | 'value' | 'enabled'>[]
  body: RequestBody
}

export interface ScriptResponse {
  code: number
  status: string
  headers: [string, string][]
  body: string
  responseTime: number
  responseSize: number
}

export interface TestResult {
  name: string
  passed: boolean
  skipped?: boolean
  error?: string
}

export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  message: string
  source: string
}

/** Where a script runs: exposed to scripts as pm.info. */
export interface ScriptInfo {
  /** Zero-based. Single sends are iteration 0 of 1. */
  iteration: number
  iterationCount: number
}

export interface ScriptJob {
  phase: 'prerequest' | 'test'
  scripts: { label: string; code: string }[]
  request: ScriptRequest
  response?: ScriptResponse
  scopes: Scopes
  info?: ScriptInfo
}

export interface ScriptOutcome {
  scopes: Scopes
  request: ScriptRequest
  tests: TestResult[]
  logs: LogEntry[]
  error?: string
  skipRequest?: boolean
  /**
   * Set by pm.execution.setNextRequest(): the name of the request a collection
   * run should continue with, or null to stop the run. Undefined = not set.
   */
  nextRequest?: string | null
}

/** What a script passes to pm.sendRequest, normalized. */
export interface SendRequestSpec {
  url: string
  method: string
  headers: [string, string][]
  body?: { mode: 'raw'; raw: string } | { mode: 'urlencoded'; pairs: [string, string][] }
}

export type WorkerInbound =
  | { type: 'run'; job: ScriptJob }
  | { type: 'sendRequestResult'; id: number; error?: string; response?: ScriptResponse }

export type WorkerOutbound =
  | { type: 'done'; outcome: ScriptOutcome }
  | { type: 'sendRequest'; id: number; spec: SendRequestSpec }
