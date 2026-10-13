import { uid } from '@shared/model'
import type { Collection, ExecOptions, Folder, PreparedRequest, Settings } from '@shared/types'
import { activeEnvironment, useWorkspace, type RequestTab } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { findPath } from '@shared/tree'
import { effectiveAuth, prepareRequest } from '@shared/engine/prepare'
import { executeRequest, type EngineDeps } from '@shared/engine/execute'
import { toMap, type Scopes } from '@shared/engine/variables'
import { askVariables } from '../store/dialogs'
import { saveVariable } from './actions'
import { runScripts } from './scriptHost'

export const execOptions = (s: Settings): ExecOptions => ({
  timeoutMs: s.timeoutMs,
  followRedirects: s.followRedirects,
  maxRedirects: s.maxRedirects,
  verifySsl: s.verifySsl,
  useCookieJar: s.useCookieJar
})

export interface RequestContext {
  collection: Collection | null
  parents: Folder[]
  scopes: Scopes
}

/** Collects the collection, folder chain and variable scopes that apply to a request tab. */
export function contextFor(tab: Pick<RequestTab, 'id' | 'collectionId' | 'requestId'>): RequestContext {
  const ws = useWorkspace.getState()
  const collection = tab.collectionId ? (ws.collections.find((c) => c.id === tab.collectionId) ?? null) : null
  const parents = collection && tab.requestId ? (findPath(collection, tab.requestId)?.parents ?? []) : []
  return {
    collection,
    parents,
    scopes: {
      globals: toMap(ws.globals),
      collection: toMap(collection?.variables),
      environment: toMap(activeEnvironment(ws)?.variables),
      data: {},
      // The tab's temporary values (set via a variable's "This tab only").
      local: { ...useRuntime.getState().tabVars[tab.id] }
    }
  }
}

/** Prepares a request without running scripts (used for code snippets). */
export function previewPrepared(tab: RequestTab): PreparedRequest {
  const ctx = contextFor(tab)
  return prepareRequest(tab.draft, effectiveAuth(tab.draft, ctx.parents, ctx.collection), ctx.scopes)
}

/** The app's engine: requests go through the main process, scripts through the Web Worker sandbox. */
export const appEngine: EngineDeps = { send: (req, opts) => window.api.send(req, opts), runScripts }

export function cancelTab(tabId: string): void {
  const rt = useRuntime.getState()
  const execId = rt.sending[tabId]
  if (!execId) return
  rt.setSending(tabId, null)
  void window.api.cancel(execId)
  rt.setResult(tabId, {
    at: Date.now(),
    result: { ok: false, error: { message: 'Request cancelled', code: 'ECANCELLED' } },
    tests: [],
    logs: [],
    scriptErrors: []
  })
}

export async function sendTab(tabId: string): Promise<void> {
  const ws = useWorkspace.getState()
  const rt = useRuntime.getState()
  const tab = ws.tabs.find((t) => t.id === tabId)
  if (tab?.kind !== 'request' || rt.sending[tabId]) return
  if (!tab.draft.url.trim()) return

  const execId = uid()
  rt.setSending(tabId, execId)
  const stillCurrent = (): boolean => useRuntime.getState().sending[tabId] === execId
  const ctx = contextFor(tab)

  const run = await executeRequest(
    {
      request: tab.draft,
      collection: ctx.collection,
      parents: ctx.parents,
      scopes: ctx.scopes,
      opts: execOptions(ws.settings),
      scriptTimeoutMs: ws.settings.scriptTimeoutMs,
      execId,
      isCancelled: () => !stillCurrent(),
      onMissingVariables: ws.settings.askForMissingVariables
        ? async (names, scopes) => {
            const env = activeEnvironment(useWorkspace.getState())
            const answer = await askVariables({ names, environmentName: env?.name, collectionName: ctx.collection?.name })
            if (!answer) return 'abort'
            if (answer.action === 'send') {
              Object.assign(scopes.local, answer.values)
              if (answer.target !== 'once')
                for (const [name, value] of Object.entries(answer.values))
                  saveVariable({ name, value, target: answer.target, collectionId: ctx.collection?.id, tabId })
            }
            return 'continue'
          }
        : undefined
    },
    appEngine
  )
  if (run.cancelled || !stillCurrent()) return

  const w = useWorkspace.getState()
  w.applyScriptScopes(ctx.collection?.id ?? null, ctx.scopes, run.scopes)
  useRuntime.getState().setResult(tabId, {
    at: run.at,
    prepared: run.prepared,
    result: run.result,
    error: run.error,
    tests: run.tests,
    logs: run.logs,
    scriptErrors: run.scriptErrors
  })
  useRuntime.getState().setSending(tabId, null)
  if (run.prepared) {
    const res = run.result
    w.addHistory({
      id: uid(),
      at: run.at,
      request: structuredClone(tab.draft),
      resolvedUrl: run.prepared.url,
      status: res?.ok ? res.response.status : undefined,
      timeMs: res?.ok ? Math.round(res.response.timings.total) : undefined,
      error: res && !res.ok ? res.error.message : undefined
    })
  }
}
