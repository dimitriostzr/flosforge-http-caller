import { runCollection, type RunItem } from '@shared/engine/collectionRun'
import { toMap } from '@shared/engine/variables'
import { findItem, findPath, flattenRequests } from '@shared/tree'
import type { Collection } from '@shared/types'
import { activeEnvironment, useWorkspace, type RunnerTab } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { toast } from '../store/dialogs'
import { appEngine, execOptions } from './runner'

/** Everything a runner tab could run, in tree order, with each request's folder chain. */
export function runTarget(tab: Pick<RunnerTab, 'collectionId' | 'folderId'>): { collection: Collection; name: string; items: RunItem[] } | null {
  const collection = useWorkspace.getState().collections.find((c) => c.id === tab.collectionId)
  if (!collection) return null
  if (!tab.folderId) return { collection, name: collection.name, items: flattenRequests(collection.items) }
  const folder = findItem(collection, tab.folderId)
  if (folder?.kind !== 'folder') return null
  const parents = [...(findPath(collection, folder.id)?.parents ?? []), folder]
  return { collection, name: folder.name, items: flattenRequests(folder.items, parents) }
}

export async function startRun(tabId: string): Promise<void> {
  const ws = useWorkspace.getState()
  const tab = ws.tabs.find((t) => t.id === tabId)
  if (tab?.kind !== 'runner' || useRuntime.getState().runs[tabId]?.status === 'running') return
  const target = runTarget(tab)
  if (!target) return
  const { config } = tab
  const items = config.selected ? target.items.filter((i) => config.selected!.includes(i.request.id)) : target.items
  if (!items.length) {
    toast('Select at least one request to run', 'error')
    return
  }

  const scopes = {
    globals: toMap(ws.globals),
    collection: toMap(target.collection.variables),
    environment: toMap(activeEnvironment(ws)?.variables),
    data: {},
    local: {}
  }
  const totalIterations = config.data?.rows.length || Math.max(1, config.iterations)
  const rt = useRuntime.getState()
  rt.setRun(tabId, () => ({ status: 'running', startedAt: Date.now(), totalIterations, steps: [] }))

  const summary = await runCollection({
    collection: target.collection,
    items,
    scopes,
    options: {
      iterations: config.iterations,
      data: config.data?.rows,
      delayMs: config.delayMs,
      bail: config.bail,
      opts: execOptions(ws.settings),
      scriptTimeoutMs: ws.settings.scriptTimeoutMs,
      environmentActive: !!activeEnvironment(ws)
    },
    deps: appEngine,
    onStep: (step) => useRuntime.getState().setRun(tabId, (r) => r && { ...r, steps: [...r.steps, step] }),
    onProgress: (progress) => useRuntime.getState().setRun(tabId, (r) => r && { ...r, progress }),
    isCancelled: () => !!useRuntime.getState().runs[tabId]?.cancelRequested
  })

  if (config.persistVariables) useWorkspace.getState().applyScriptScopes(target.collection.id, scopes, summary.scopes)
  useRuntime.getState().setRun(tabId, (r) => r && { ...r, status: 'done', progress: undefined, summary })
}

export function stopRun(tabId: string): void {
  useRuntime.getState().setRun(tabId, (r) => r && { ...r, cancelRequested: true })
}
