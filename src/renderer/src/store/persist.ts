import type { Collection } from '@shared/types'
import { useWorkspace, type WorkspaceStore } from './workspace'

// Watches the store and writes changed slices to disk (debounced). Immer gives
// us structural sharing, so reference equality tells us what changed.
//
// Workspace-scoped saves remember which workspace they belong to when they are
// scheduled. Switching workspaces always flushes first (see switchWorkspace), and
// the change that loads another workspace's data is never written back.

function debounce(fn: () => Promise<unknown>, ms: number): { (): void; flush(): Promise<unknown> } {
  let t: ReturnType<typeof setTimeout> | undefined
  let last: Promise<unknown> = Promise.resolve()
  const run = (): Promise<unknown> => {
    t = undefined
    last = fn().catch((e) => console.error('Save failed', e))
    return last
  }
  const d = (): void => {
    clearTimeout(t)
    t = setTimeout(run, ms)
  }
  d.flush = (): Promise<unknown> => {
    if (t === undefined) return last
    clearTimeout(t)
    return run()
  }
  return d
}

let flushAll: () => Promise<unknown> = () => Promise.resolve()

/** Writes every pending change now. */
export const flushPersistence = (): Promise<unknown> => flushAll()

export function startPersistence(): () => void {
  const api = window.api
  const ws = () => useWorkspace.getState()
  // Collection writes are queued per workspace+collection so nothing crosses workspaces.
  const pendingCollections = new Map<string, { wsId: string; c: Collection }>()
  const deletedCollections = new Map<string, { wsId: string; id: string }>()

  /** Debounced save of one workspace-scoped slice, bound to the workspace that changed. */
  const scoped = (save: (wsId: string) => Promise<unknown>, ms: number) => {
    let wsId = ''
    const d = debounce(() => save(wsId), ms)
    const schedule = (id: string): void => {
      if (wsId && wsId !== id) void d.flush()
      wsId = id
      d()
    }
    return Object.assign(schedule, { flush: d.flush })
  }

  const saveCollections = debounce(() => {
    const ops = [
      ...[...deletedCollections.values()].map((d) => api.deleteCollection(d.wsId, d.id)),
      ...[...pendingCollections.values()].map((p) => api.saveCollection(p.wsId, p.c))
    ]
    deletedCollections.clear()
    pendingCollections.clear()
    return Promise.all(ops)
  }, 400)
  const saveEnvironments = scoped((id) => api.saveEnvironments(id, ws().environments), 400)
  const saveGlobals = scoped((id) => api.saveGlobals(id, ws().globals), 400)
  const saveHistory = scoped((id) => api.saveHistory(id, ws().history), 1000)
  const saveFlows = scoped((id) => api.saveFlows(id, ws().flows), 400)
  const saveSession = scoped((id) => {
    const s = ws()
    return api.saveSession(id, {
      activeEnvironmentId: s.activeEnvironmentId,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      sidebarWidth: s.sidebarWidth,
      splitRatio: s.splitRatio,
      expanded: s.expanded
    })
  }, 800)
  const saveSettings = debounce(() => api.saveSettings(ws().settings), 200)
  const saveIndex = debounce(() => api.saveWorkspaces({ workspaces: ws().workspaces, activeId: ws().activeWorkspaceId }), 200)

  const unsub = useWorkspace.subscribe((s: WorkspaceStore, prev: WorkspaceStore) => {
    if (!s.loaded || !prev.loaded) return
    if (s.settings !== prev.settings) saveSettings()
    if (s.workspaces !== prev.workspaces || s.activeWorkspaceId !== prev.activeWorkspaceId) saveIndex()
    // Another workspace was just loaded: nothing in it has changed yet.
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) return

    const wsId = s.activeWorkspaceId
    if (s.collections !== prev.collections) {
      const prevById = new Map(prev.collections.map((c) => [c.id, c]))
      for (const c of s.collections) {
        const key = `${wsId}/${c.id}`
        if (prevById.get(c.id) !== c) {
          pendingCollections.set(key, { wsId, c })
          deletedCollections.delete(key)
        }
        prevById.delete(c.id)
      }
      for (const id of prevById.keys()) {
        const key = `${wsId}/${id}`
        deletedCollections.set(key, { wsId, id })
        pendingCollections.delete(key)
      }
      saveCollections()
    }
    if (s.environments !== prev.environments) saveEnvironments(wsId)
    if (s.globals !== prev.globals) saveGlobals(wsId)
    if (s.history !== prev.history) saveHistory(wsId)
    if (s.flows !== prev.flows) saveFlows(wsId)
    if (
      s.tabs !== prev.tabs ||
      s.activeTabId !== prev.activeTabId ||
      s.activeEnvironmentId !== prev.activeEnvironmentId ||
      s.sidebarWidth !== prev.sidebarWidth ||
      s.splitRatio !== prev.splitRatio ||
      s.expanded !== prev.expanded
    )
      saveSession(wsId)
  })

  flushAll = () =>
    Promise.all([
      saveCollections.flush(),
      saveEnvironments.flush(),
      saveGlobals.flush(),
      saveHistory.flush(),
      saveFlows.flush(),
      saveSession.flush(),
      saveSettings.flush(),
      saveIndex.flush()
    ])
  // The main process asks for a flush before the window closes.
  const offFlush = api.onFlushRequest(flushAll)
  return () => {
    unsub()
    offFlush()
    void flushAll()
  }
}
