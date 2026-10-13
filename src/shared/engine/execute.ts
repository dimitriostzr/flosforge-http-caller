import { uid } from '../model'
import { paramsFromUrl } from '../url'
import type { ApiRequest, Collection, ExecOptions, ExecResult, Folder, PreparedRequest } from '../types'
import { decodeBody } from './body'
import { effectiveAuth, missingVariables, prepareRequest } from './prepare'
import { hasScripts, type RunScripts } from './scriptRunner'
import type { LogEntry, ScriptInfo, ScriptJob, ScriptOutcome, ScriptRequest, TestResult } from './scriptTypes'
import { findVariableRefs, type Scopes } from './variables'

// Executes one request end to end: pre-request scripts → variables and auth →
// HTTP → test scripts. Shared by the Send button, the collection runner and the
// CLI; each supplies how to send and how to run scripts.

export interface EngineDeps {
  send(req: PreparedRequest, opts: ExecOptions): Promise<ExecResult>
  runScripts: RunScripts
}

export interface ExecuteInput {
  request: ApiRequest
  collection: Collection | null
  /** Folders from the collection root down to the request. */
  parents: Folder[]
  /** Variable scopes at the start; the result carries them after scripts ran. */
  scopes: Scopes
  opts: ExecOptions
  scriptTimeoutMs: number
  info?: ScriptInfo
  execId?: string
  /**
   * Called when variables still have no value after pre-request scripts. It may
   * fill them in (e.g. by asking the user) or abort. Without it, the request is
   * sent as is and a warning is logged.
   */
  onMissingVariables?: (names: string[], scopes: Scopes) => Promise<'continue' | 'abort'>
  /** Checked after every await; true drops the result (the user cancelled). */
  isCancelled?: () => boolean
}

export interface ExecuteResult {
  at: number
  /** The request as sent: after pre-request scripts changed it. */
  request: ApiRequest
  prepared?: PreparedRequest
  result?: ExecResult
  /** Why the request wasn't sent (or couldn't run), when it wasn't. */
  error?: string
  tests: TestResult[]
  logs: LogEntry[]
  scriptErrors: string[]
  scopes: Scopes
  /** From pm.execution.setNextRequest: undefined = not set, null = stop the run. */
  nextRequest?: string | null
  skipped?: boolean
  cancelled?: boolean
}

const toScriptRequest = (r: ApiRequest): ScriptRequest => ({
  id: r.id,
  name: r.name,
  method: r.method,
  url: r.url,
  headers: r.headers.map(({ key, value, enabled }) => ({ key, value, enabled })),
  body: r.body
})

function mergeScriptRequest(r: ApiRequest, s: ScriptRequest): ApiRequest {
  const headers = s.headers.map((h, i) => ({ id: r.headers[i]?.id ?? uid(), ...h }))
  return { ...r, method: s.method, url: s.url, params: paramsFromUrl(s.url, r.params), headers, body: s.body }
}

/** Collection → folders → request: outermost scripts run first. */
export function scriptChain(
  key: 'preRequest' | 'test',
  collection: Collection | null,
  parents: Folder[],
  req: ApiRequest
): ScriptJob['scripts'] {
  return [
    ...(collection ? [{ label: `${collection.name} (collection)`, code: collection.scripts[key] }] : []),
    ...parents.map((f) => ({ label: `${f.name} (folder)`, code: f.scripts[key] })),
    { label: req.name, code: req.scripts[key] }
  ]
}

export async function executeRequest(input: ExecuteInput, deps: EngineDeps): Promise<ExecuteResult> {
  const { collection, parents, opts, scriptTimeoutMs, info } = input
  const cancelled = (): boolean => !!input.isCancelled?.()
  const out: ExecuteResult = {
    at: Date.now(),
    request: structuredClone(input.request),
    tests: [],
    logs: [],
    scriptErrors: [],
    scopes: structuredClone(input.scopes)
  }
  const absorb = (o: ScriptOutcome): void => {
    out.logs.push(...o.logs)
    out.tests.push(...o.tests)
    if (o.error) out.scriptErrors.push(o.error)
    out.scopes = o.scopes
    if (o.nextRequest !== undefined) out.nextRequest = o.nextRequest
  }

  try {
    const pre: ScriptJob = {
      phase: 'prerequest',
      scripts: scriptChain('preRequest', collection, parents, out.request),
      request: toScriptRequest(out.request),
      scopes: out.scopes,
      info
    }
    if (hasScripts(pre)) {
      const o = await deps.runScripts(pre, scriptTimeoutMs, opts)
      if (cancelled()) return { ...out, cancelled: true }
      absorb(o)
      out.request = mergeScriptRequest(out.request, o.request)
      if (o.error) {
        // A failing pre-request script stops the request from being sent.
        out.error = `Pre-request script failed, request not sent. ${o.error}`
        return out
      }
      if (o.skipRequest) {
        out.error = 'Request skipped by pre-request script'
        out.skipped = true
        return out
      }
    }

    const auth = effectiveAuth(out.request, parents, collection)
    if (input.onMissingVariables) {
      const missing = missingVariables(out.request, auth, out.scopes)
      if (missing.length) {
        const decision = await input.onMissingVariables(missing, out.scopes)
        if (cancelled()) return { ...out, cancelled: true }
        if (decision === 'abort') {
          out.error = `Request not sent: no value for ${missing.map((n) => `{{${n}}}`).join(', ')}`
          return out
        }
      }
    }

    const prepared = { ...prepareRequest(out.request, auth, out.scopes), execId: input.execId ?? uid() }
    out.prepared = prepared
    const unresolved = new Set(findVariableRefs(prepared.url).map((r) => r.name))
    for (const [k, v] of prepared.headers) findVariableRefs(k + v).forEach((r) => unresolved.add(r.name))
    if (prepared.body.type === 'text') findVariableRefs(prepared.body.text).forEach((r) => unresolved.add(r.name))
    for (const name of unresolved) out.logs.push({ level: 'warn', message: `Unresolved variable {{${name}}}`, source: 'request' })

    const result = await deps.send(prepared, opts)
    if (cancelled()) return { ...out, cancelled: true }
    out.result = result

    if (result.ok) {
      const post: ScriptJob = {
        phase: 'test',
        scripts: scriptChain('test', collection, parents, out.request),
        request: toScriptRequest(out.request),
        scopes: out.scopes,
        info,
        response: {
          code: result.response.status,
          status: result.response.statusText,
          headers: result.response.headers,
          body: decodeBody(result.response.body, result.response.headers),
          responseTime: Math.round(result.response.timings.total),
          responseSize: result.response.bodySize
        }
      }
      if (hasScripts(post)) {
        const o = await deps.runScripts(post, scriptTimeoutMs, opts)
        if (cancelled()) return { ...out, cancelled: true }
        absorb(o)
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
  }
  return out
}
