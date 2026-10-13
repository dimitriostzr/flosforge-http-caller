import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current, isDraft, type Draft } from 'immer'
import { cloneWithNewIds, newCollection, newEnvironment, newFolder, newRequest, uid, variable } from '@shared/model'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  ApiRequest,
  Collection,
  Environment,
  HistoryEntry,
  Settings,
  TreeItem,
  Variable,
  BootData,
  Workspace,
  WorkspaceData
} from '@shared/types'
import type { ImportResult } from '@shared/importers'
import { findItem, findParent, findPath, getContainer, isDescendant, removeItem, replaceItem } from '@shared/tree'
import type { VarMap } from '@shared/engine/variables'

export type RequestTab = {
  kind: 'request'
  id: string
  collectionId: string | null
  requestId: string | null
  draft: ApiRequest
  dirty: boolean
  /** Preview tabs are replaced by the next single-click open, like in code editors. */
  preview?: boolean
}
export type ItemSettingsTab = { kind: 'collection' | 'folder'; id: string; collectionId: string; itemId: string }
export type EnvironmentTab = { kind: 'environment'; id: string; environmentId: string }
export type GlobalsTab = { kind: 'globals'; id: string }

export interface RunnerConfig {
  /** Request ids to run, in tree order. Null runs everything in the target. */
  selected: string[] | null
  iterations: number
  delayMs: number
  bail: boolean
  /** Keep variable changes made by scripts (environment, collection, globals). */
  persistVariables: boolean
  data: { name: string; columns: string[]; rows: Record<string, string>[] } | null
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  selected: null,
  iterations: 1,
  delayMs: 0,
  bail: false,
  persistVariables: true,
  data: null
}

/** Runs a collection, or one folder of it. */
export type RunnerTab = { kind: 'runner'; id: string; collectionId: string; folderId: string | null; config: RunnerConfig }
export type Tab = RequestTab | ItemSettingsTab | EnvironmentTab | GlobalsTab | RunnerTab

export type SidebarPanel = 'collections' | 'environments' | 'history'

interface State {
  loaded: boolean
  /** All workspaces; only the active one's data is loaded below. */
  workspaces: Workspace[]
  activeWorkspaceId: string
  collections: Collection[]
  environments: Environment[]
  globals: Variable[]
  activeEnvironmentId: string | null
  settings: Settings
  history: HistoryEntry[]
  tabs: Tab[]
  activeTabId: string | null
  sidebarPanel: SidebarPanel
  sidebarVisible: boolean
  sidebarWidth: number
  splitRatio: number
  expanded: Record<string, boolean>
}

interface Actions {
  hydrate(boot: BootData): void
  /** Replaces everything workspace-scoped with another workspace's data. */
  loadWorkspaceData(wsId: string, data: WorkspaceData): void
  addWorkspace(name: string, color: string | null): string
  updateWorkspace(id: string, patch: Partial<Omit<Workspace, 'id'>>): void
  removeWorkspace(id: string): void

  createCollection(name?: string): string
  updateCollection(id: string, recipe: (c: Collection) => void): void
  deleteCollection(id: string): void
  duplicateCollection(id: string): void

  addRequest(collectionId: string, parentId: string | null, partial?: Partial<ApiRequest>): void
  addFolder(collectionId: string, parentId: string | null, name: string): void
  renameItem(collectionId: string, itemId: string, name: string): void
  deleteItem(collectionId: string, itemId: string): void
  duplicateItem(collectionId: string, itemId: string): void
  moveItem(fromCollectionId: string, itemId: string, toCollectionId: string, toParentId: string | null, index?: number): void

  importData(result: ImportResult): void

  openRequest(collectionId: string, requestId: string, opts?: { preview?: boolean }): void
  openScratch(request?: ApiRequest): void
  openItemSettings(collectionId: string, itemId: string): void
  openEnvironment(environmentId: string): void
  openGlobals(): void
  openRunner(collectionId: string, folderId: string | null): void
  updateRunnerConfig(tabId: string, recipe: (c: RunnerConfig) => void): void
  setActiveTab(id: string): void
  cycleTab(delta: number): void
  closeTab(id: string): void
  closeTabs(ids: string[]): void
  pinTab(id: string): void
  updateDraft(tabId: string, recipe: (r: ApiRequest) => void): void
  /** Writes a request tab back to its collection. Returns false for scratch tabs (caller asks where to save). */
  saveTab(tabId: string): boolean
  saveTabAs(tabId: string, collectionId: string, parentId: string | null, name: string): void
  revertTab(tabId: string): void

  createEnvironment(name?: string, variables?: Variable[]): string
  updateEnvironment(id: string, recipe: (e: Environment) => void): void
  deleteEnvironment(id: string): void
  duplicateEnvironment(id: string): void
  setActiveEnvironment(id: string | null): void
  updateGlobals(recipe: (g: Variable[]) => void): void
  /** Persists variable changes made by scripts. */
  applyScriptScopes(collectionId: string | null, before: Record<'globals' | 'collection' | 'environment', VarMap>, after: Record<'globals' | 'collection' | 'environment', VarMap>): void

  updateSettings(partial: Partial<Settings>): void
  addHistory(entry: HistoryEntry): void
  removeHistory(id: string): void
  clearHistory(): void

  setSidebarPanel(p: SidebarPanel): void
  toggleSidebar(): void
  setSidebarWidth(w: number): void
  setSplitRatio(r: number): void
  setExpanded(id: string, open: boolean): void
}

export type WorkspaceStore = State & Actions

/** structuredClone that also works on immer drafts (which are Proxies). */
const clone = <T,>(x: T): T => structuredClone(isDraft(x) ? (current(x as Draft<T>) as T) : x)

const touch = (c: Collection): void => {
  c.updatedAt = Date.now()
}

/** Merges script-side variable edits into a persisted variable list. */
function applyVarDiff(list: Variable[], before: VarMap, after: VarMap): void {
  for (const [k, v] of Object.entries(after)) {
    if (before[k] === v) continue
    const existing = list.find((x) => x.key === k && x.enabled) ?? list.find((x) => x.key === k)
    if (existing) {
      existing.value = v
      existing.enabled = true
    } else list.push(variable(k, v))
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) {
      const idx = list.findIndex((x) => x.key === k && x.enabled)
      if (idx !== -1) list.splice(idx, 1)
    }
  }
}

const mapChanged = (a: VarMap, b: VarMap): boolean => {
  const ka = Object.keys(a)
  return ka.length !== Object.keys(b).length || ka.some((k) => a[k] !== b[k])
}

export const useWorkspace: UseBoundStore<StoreApi<WorkspaceStore>> = create<WorkspaceStore>()(
  immer((set, get) => {
    const closeWhere = (s: State, pred: (t: Tab) => boolean): void => {
      const closing = s.tabs.filter(pred).map((t) => t.id)
      if (!closing.length) return
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId)
      s.tabs = s.tabs.filter((t) => !closing.includes(t.id))
      if (s.activeTabId && closing.includes(s.activeTabId)) {
        s.activeTabId = s.tabs[Math.min(idx, s.tabs.length - 1)]?.id ?? null
      }
    }

    const openTab = (s: State, tab: Tab, preview = false): void => {
      if (preview) {
        const i = s.tabs.findIndex((t) => t.kind === 'request' && t.preview && !t.dirty)
        if (i !== -1) {
          s.tabs[i] = tab
          s.activeTabId = tab.id
          return
        }
      }
      const active = s.tabs.findIndex((t) => t.id === s.activeTabId)
      s.tabs.splice(active === -1 ? s.tabs.length : active + 1, 0, tab)
      s.activeTabId = tab.id
    }

    const expandTo = (s: State, c: Collection, itemId: string): void => {
      s.expanded[c.id] = true
      findPath(c, itemId)?.parents.forEach((p) => (s.expanded[p.id] = true))
    }

    return {
      loaded: false,
      workspaces: [],
      activeWorkspaceId: '',
      collections: [],
      environments: [],
      globals: [],
      activeEnvironmentId: null,
      settings: DEFAULT_SETTINGS,
      history: [],
      tabs: [],
      activeTabId: null,
      sidebarPanel: 'collections',
      sidebarVisible: true,
      sidebarWidth: 300,
      splitRatio: 0.5,
      expanded: {},

      hydrate: (boot) => {
        set((s) => {
          s.workspaces = boot.index.workspaces
          s.settings = boot.settings
        })
        get().loadWorkspaceData(boot.index.activeId, boot.data)
      },

      loadWorkspaceData: (wsId, data) =>
        set((s) => {
          s.activeWorkspaceId = wsId
          s.collections = data.collections
          s.environments = data.environments
          s.globals = data.globals
          s.history = data.history
          s.activeEnvironmentId = data.environments.some((e) => e.id === data.session.activeEnvironmentId)
            ? data.session.activeEnvironmentId
            : null
          const tabs = (Array.isArray(data.session.tabs) ? data.session.tabs : []) as Tab[]
          s.tabs = tabs.filter((t) => t && typeof t === 'object' && 'kind' in t && 'id' in t)
          s.activeTabId = s.tabs.some((t) => t.id === data.session.activeTabId)
            ? (data.session.activeTabId ?? null)
            : (s.tabs[0]?.id ?? null)
          if (data.session.sidebarWidth) s.sidebarWidth = data.session.sidebarWidth
          if (data.session.splitRatio) s.splitRatio = data.session.splitRatio
          s.expanded = data.session.expanded ?? {}
          s.loaded = true
        }),

      addWorkspace: (name, color) => {
        const ws: Workspace = { id: uid(), name, color, createdAt: Date.now() }
        set((s) => {
          s.workspaces.push(ws)
        })
        return ws.id
      },

      updateWorkspace: (id, patch) =>
        set((s) => {
          const ws = s.workspaces.find((w) => w.id === id)
          if (ws) Object.assign(ws, patch)
        }),

      removeWorkspace: (id) =>
        set((s) => {
          if (s.workspaces.length > 1 && id !== s.activeWorkspaceId) s.workspaces = s.workspaces.filter((w) => w.id !== id)
        }),

      // --- Collections -------------------------------------------------------

      createCollection: (name = 'New collection') => {
        const c = newCollection({ name })
        set((s) => {
          s.collections.push(c)
          s.expanded[c.id] = true
        })
        return c.id
      },

      updateCollection: (id, recipe) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === id)
          if (!c) return
          recipe(c)
          touch(c)
        }),

      deleteCollection: (id) =>
        set((s) => {
          s.collections = s.collections.filter((c) => c.id !== id)
          closeWhere(s, (t) => ('collectionId' in t && t.collectionId === id && (t.kind !== 'request' || !t.dirty)))
          // Dirty tabs of a deleted collection survive as unsaved scratch requests.
          for (const t of s.tabs) if (t.kind === 'request' && t.collectionId === id) Object.assign(t, { collectionId: null, requestId: null })
        }),

      duplicateCollection: (id) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === id)
          if (!c) return
          const copy = clone(c)
          copy.id = uid()
          copy.name = `${c.name} copy`
          copy.items = copy.items.map((i) => cloneWithNewIds(i))
          copy.createdAt = copy.updatedAt = Date.now()
          s.collections.push(copy)
        }),

      // --- Tree items ---------------------------------------------------------

      addRequest: (collectionId, parentId, partial) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === collectionId)
          const container = c && getContainer(c, parentId)
          if (!c || !container) return
          const req = newRequest(partial)
          container.items.push(req)
          touch(c)
          expandTo(s, c, req.id)
          openTab(s, { kind: 'request', id: uid(), collectionId, requestId: req.id, draft: structuredClone(req), dirty: false })
        }),

      addFolder: (collectionId, parentId, name) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === collectionId)
          const container = c && getContainer(c, parentId)
          if (!c || !container) return
          const f = newFolder({ name })
          container.items.push(f)
          touch(c)
          expandTo(s, c, f.id)
        }),

      renameItem: (collectionId, itemId, name) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === collectionId)
          if (!c) return
          if (itemId === collectionId) c.name = name
          else {
            const it = findItem(c, itemId)
            if (!it) return
            it.name = name
          }
          touch(c)
          for (const t of s.tabs) if (t.kind === 'request' && t.requestId === itemId) t.draft.name = name
        }),

      deleteItem: (collectionId, itemId) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === collectionId)
          if (!c) return
          const removed = removeItem(c, itemId)
          if (!removed) return
          touch(c)
          const gone = new Set<string>()
          const walk = (i: TreeItem): void => {
            gone.add(i.id)
            if (i.kind === 'folder') i.items.forEach(walk)
          }
          walk(removed)
          closeWhere(s, (t) =>
            (t.kind === 'request' && !!t.requestId && gone.has(t.requestId) && !t.dirty) ||
            (t.kind === 'folder' && gone.has(t.itemId))
          )
          for (const t of s.tabs)
            if (t.kind === 'request' && t.requestId && gone.has(t.requestId)) Object.assign(t, { collectionId: null, requestId: null })
        }),

      duplicateItem: (collectionId, itemId) =>
        set((s) => {
          const c = s.collections.find((x) => x.id === collectionId)
          if (!c) return
          const parent = findParent(c, itemId)
          const it = findItem(c, itemId)
          if (!parent || !it) return
          const copy = cloneWithNewIds(clone(it as TreeItem))
          copy.name = `${it.name} copy`
          parent.items.splice(parent.items.findIndex((i) => i.id === itemId) + 1, 0, copy)
          touch(c)
        }),

      moveItem: (fromCollectionId, itemId, toCollectionId, toParentId, index) =>
        set((s) => {
          const from = s.collections.find((x) => x.id === fromCollectionId)
          const to = s.collections.find((x) => x.id === toCollectionId)
          if (!from || !to) return
          const item = findItem(from, itemId)
          if (!item) return
          if (toParentId === itemId) return
          if (item.kind === 'folder' && toParentId && isDescendant(item, toParentId)) return
          const oldParent = findParent(from, itemId)!
          const oldIndex = oldParent.items.findIndex((i) => i.id === itemId)
          removeItem(from, itemId)
          const target = getContainer(to, toParentId)
          if (!target) {
            oldParent.items.splice(oldIndex, 0, item)
            return
          }
          let at = index ?? target.items.length
          if (target === oldParent && index !== undefined && oldIndex < index) at--
          target.items.splice(Math.max(0, Math.min(at, target.items.length)), 0, item)
          touch(from)
          touch(to)
          if (toParentId) s.expanded[toParentId] = true
          if (fromCollectionId !== toCollectionId) {
            const ids = new Set<string>()
            const walk = (i: TreeItem): void => {
              ids.add(i.id)
              if (i.kind === 'folder') i.items.forEach(walk)
            }
            walk(item)
            for (const t of s.tabs) {
              if (t.kind === 'request' && t.requestId && ids.has(t.requestId)) t.collectionId = toCollectionId
              if (t.kind === 'folder' && ids.has(t.itemId)) t.collectionId = toCollectionId
            }
          }
        }),

      importData: (result) =>
        set((s) => {
          for (const c of result.collections) {
            s.collections.push(c)
            s.expanded[c.id] = true
          }
          for (const e of result.environments) s.environments.push(e)
          for (const g of result.globals) {
            const existing = s.globals.find((x) => x.key === g.key)
            if (existing) existing.value = g.value
            else s.globals.push(g)
          }
          if (result.request)
            openTab(s, { kind: 'request', id: uid(), collectionId: null, requestId: null, draft: result.request, dirty: true })
          if (result.collections.length) s.sidebarPanel = 'collections'
          else if (result.environments.length) s.sidebarPanel = 'environments'
        }),

      // --- Tabs --------------------------------------------------------------------

      openRequest: (collectionId, requestId, opts) =>
        set((s) => {
          const existing = s.tabs.find((t) => t.kind === 'request' && t.requestId === requestId)
          if (existing) {
            s.activeTabId = existing.id
            if (!opts?.preview && existing.kind === 'request') existing.preview = false
            return
          }
          const c = s.collections.find((x) => x.id === collectionId)
          const it = c && findItem(c, requestId)
          if (!it || it.kind !== 'request') return
          openTab(
            s,
            { kind: 'request', id: uid(), collectionId, requestId, draft: clone(it) as ApiRequest, dirty: false, preview: !!opts?.preview },
            !!opts?.preview
          )
        }),

      openScratch: (request) =>
        set((s) => {
          openTab(s, {
            kind: 'request',
            id: uid(),
            collectionId: null,
            requestId: null,
            draft: request ?? newRequest({ name: 'Untitled request', auth: { type: 'none' } }),
            dirty: !!request
          })
        }),

      openItemSettings: (collectionId, itemId) =>
        set((s) => {
          const kind = itemId === collectionId ? 'collection' : 'folder'
          const existing = s.tabs.find((t) => (t.kind === 'collection' || t.kind === 'folder') && t.itemId === itemId)
          if (existing) s.activeTabId = existing.id
          else openTab(s, { kind, id: uid(), collectionId, itemId })
        }),

      openEnvironment: (environmentId) =>
        set((s) => {
          const existing = s.tabs.find((t) => t.kind === 'environment' && t.environmentId === environmentId)
          if (existing) s.activeTabId = existing.id
          else openTab(s, { kind: 'environment', id: uid(), environmentId })
        }),

      openGlobals: () =>
        set((s) => {
          const existing = s.tabs.find((t) => t.kind === 'globals')
          if (existing) s.activeTabId = existing.id
          else openTab(s, { kind: 'globals', id: uid() })
        }),

      openRunner: (collectionId, folderId) =>
        set((s) => {
          const existing = s.tabs.find((t) => t.kind === 'runner' && t.collectionId === collectionId && t.folderId === folderId)
          if (existing) s.activeTabId = existing.id
          else openTab(s, { kind: 'runner', id: uid(), collectionId, folderId, config: structuredClone(DEFAULT_RUNNER_CONFIG) })
        }),

      updateRunnerConfig: (tabId, recipe) =>
        set((s) => {
          const t = s.tabs.find((x) => x.id === tabId)
          if (t?.kind === 'runner') recipe(t.config)
        }),

      setActiveTab: (id) =>
        set((s) => {
          s.activeTabId = id
        }),

      cycleTab: (delta) =>
        set((s) => {
          if (!s.tabs.length) return
          const i = s.tabs.findIndex((t) => t.id === s.activeTabId)
          s.activeTabId = s.tabs[(i + delta + s.tabs.length) % s.tabs.length].id
        }),

      closeTab: (id) => set((s) => closeWhere(s, (t) => t.id === id)),
      closeTabs: (ids) => set((s) => closeWhere(s, (t) => ids.includes(t.id))),

      pinTab: (id) =>
        set((s) => {
          const t = s.tabs.find((x) => x.id === id)
          if (t?.kind === 'request') t.preview = false
        }),

      updateDraft: (tabId, recipe) =>
        set((s) => {
          const t = s.tabs.find((x) => x.id === tabId)
          if (t?.kind !== 'request') return
          recipe(t.draft)
          t.dirty = true
          t.preview = false
        }),

      saveTab: (tabId) => {
        const t = get().tabs.find((x) => x.id === tabId)
        if (t?.kind !== 'request') return true
        if (!t.collectionId || !t.requestId) return false
        set((s) => {
          const tab = s.tabs.find((x) => x.id === tabId) as RequestTab
          const c = s.collections.find((x) => x.id === tab.collectionId)
          if (!c) return
          const ok = replaceItem(c, clone(tab.draft))
          if (ok) {
            touch(c)
            tab.dirty = false
          }
        })
        return true
      },

      saveTabAs: (tabId, collectionId, parentId, name) =>
        set((s) => {
          const tab = s.tabs.find((x) => x.id === tabId)
          const c = s.collections.find((x) => x.id === collectionId)
          const container = c && getContainer(c, parentId)
          if (tab?.kind !== 'request' || !c || !container) return
          const req = clone(tab.draft)
          req.id = uid()
          req.name = name
          if (req.auth.type === 'none' && !tab.requestId) req.auth = { type: 'inherit' }
          container.items.push(req)
          touch(c)
          expandTo(s, c, req.id)
          Object.assign(tab, { collectionId, requestId: req.id, dirty: false, preview: false })
          tab.draft = structuredClone(req)
        }),

      revertTab: (tabId) =>
        set((s) => {
          const t = s.tabs.find((x) => x.id === tabId)
          if (t?.kind !== 'request' || !t.collectionId || !t.requestId) return
          const c = s.collections.find((x) => x.id === t.collectionId)
          const it = c && findItem(c, t.requestId)
          if (it?.kind !== 'request') return
          t.draft = clone(it) as ApiRequest
          t.dirty = false
        }),

      // --- Environments & variables -------------------------------------------------

      createEnvironment: (name = 'New environment', variables = []) => {
        const e = newEnvironment({ name, variables })
        set((s) => {
          s.environments.push(e)
        })
        return e.id
      },

      updateEnvironment: (id, recipe) =>
        set((s) => {
          const e = s.environments.find((x) => x.id === id)
          if (e) recipe(e)
        }),

      deleteEnvironment: (id) =>
        set((s) => {
          s.environments = s.environments.filter((e) => e.id !== id)
          if (s.activeEnvironmentId === id) s.activeEnvironmentId = null
          closeWhere(s, (t) => t.kind === 'environment' && t.environmentId === id)
        }),

      duplicateEnvironment: (id) =>
        set((s) => {
          const e = s.environments.find((x) => x.id === id)
          if (!e) return
          s.environments.push({
            id: uid(),
            name: `${e.name} copy`,
            variables: e.variables.map((v) => ({ ...v, id: uid() }))
          })
        }),

      setActiveEnvironment: (id) =>
        set((s) => {
          s.activeEnvironmentId = id
        }),

      updateGlobals: (recipe) =>
        set((s) => {
          recipe(s.globals)
        }),

      applyScriptScopes: (collectionId, before, after) =>
        set((s) => {
          if (mapChanged(before.globals, after.globals)) applyVarDiff(s.globals, before.globals, after.globals)
          const env = s.environments.find((e) => e.id === s.activeEnvironmentId)
          if (env && mapChanged(before.environment, after.environment))
            applyVarDiff(env.variables, before.environment, after.environment)
          const c = collectionId ? s.collections.find((x) => x.id === collectionId) : undefined
          if (c && mapChanged(before.collection, after.collection)) {
            applyVarDiff(c.variables, before.collection, after.collection)
            touch(c)
          }
        }),

      // --- Settings & history ----------------------------------------------------------

      updateSettings: (partial) =>
        set((s) => {
          Object.assign(s.settings, partial)
        }),

      addHistory: (entry) =>
        set((s) => {
          s.history.unshift(entry)
          if (s.history.length > s.settings.historyLimit) s.history.length = s.settings.historyLimit
        }),

      removeHistory: (id) =>
        set((s) => {
          s.history = s.history.filter((h) => h.id !== id)
        }),

      clearHistory: () =>
        set((s) => {
          s.history = []
        }),

      // --- Layout --------------------------------------------------------------------------

      setSidebarPanel: (p) =>
        set((s) => {
          if (s.sidebarPanel === p && s.sidebarVisible) s.sidebarVisible = false
          else {
            s.sidebarPanel = p
            s.sidebarVisible = true
          }
        }),
      toggleSidebar: () =>
        set((s) => {
          s.sidebarVisible = !s.sidebarVisible
        }),
      setSidebarWidth: (w) =>
        set((s) => {
          s.sidebarWidth = Math.max(220, Math.min(600, w))
        }),
      setSplitRatio: (r) =>
        set((s) => {
          s.splitRatio = Math.max(0.15, Math.min(0.85, r))
        }),
      setExpanded: (id, open) =>
        set((s) => {
          s.expanded[id] = open
        })
    }
  })
)

/** Selectors */
export const activeTab = (s: WorkspaceStore): Tab | undefined => s.tabs.find((t) => t.id === s.activeTabId)
export const activeWorkspace = (s: WorkspaceStore): Workspace | undefined =>
  s.workspaces.find((w) => w.id === s.activeWorkspaceId)
export const activeEnvironment = (s: WorkspaceStore): Environment | undefined =>
  s.environments.find((e) => e.id === s.activeEnvironmentId)
