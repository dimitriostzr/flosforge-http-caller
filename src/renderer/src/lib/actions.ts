import { exportCollectionV21, exportEnvironmentFile, exportNative } from '@shared/importers'
import { DEMO_WORKSPACE_COLOR, DEMO_WORKSPACE_NAME, buildDemo } from '@shared/demo'
import { activeTab, useWorkspace } from '../store/workspace'
import { confirm, prompt, toast, useDialogs } from '../store/dialogs'
import { flushPersistence } from '../store/persist'
import { safeFileName } from './format'
import { useRuntime } from '../store/runtime'
import { newCapture, variable } from '@shared/model'
import { formatJsonPath, nameForPath, type JsonPath } from '@shared/engine/captures'
import type { Variable } from '@shared/types'
import { findItem } from '@shared/tree'

const ws = () => useWorkspace.getState()

export function saveActiveTab(): void {
  const tab = activeTab(ws())
  if (tab?.kind !== 'request') return
  if (!ws().saveTab(tab.id)) useDialogs.getState().openModal('saveAs', { tabId: tab.id })
  else toast('Saved', 'success')
}

/** Closes a tab, asking first when it has unsaved changes. */
export async function closeTab(id: string): Promise<void> {
  const tab = ws().tabs.find((t) => t.id === id)
  // Closing a runner tab stops its run.
  if (tab?.kind === 'runner') useRuntime.getState().setRun(id, (r) => r && { ...r, cancelRequested: true })
  if (tab?.kind === 'request' && tab.dirty) {
    const answer = await confirm({
      title: 'Unsaved changes',
      message: `“${tab.draft.name}” has unsaved changes. Save them before closing?`,
      confirmLabel: 'Save',
      altLabel: "Don't save"
    })
    if (answer === false) return
    if (answer === true && !ws().saveTab(id)) {
      useDialogs.getState().openModal('saveAs', { tabId: id, closeAfter: true })
      return
    }
  }
  ws().closeTab(id)
}

export async function closeTabs(ids: string[]): Promise<void> {
  const dirty = ws().tabs.filter((t) => ids.includes(t.id) && t.kind === 'request' && t.dirty)
  if (dirty.length) {
    const ok = await confirm({
      title: 'Discard changes?',
      message: `${dirty.length} tab${dirty.length > 1 ? 's have' : ' has'} unsaved changes that will be lost.`,
      confirmLabel: 'Close anyway',
      danger: true
    })
    if (ok !== true) return
  }
  ws().closeTabs(ids)
}

export async function createCollection(): Promise<void> {
  const name = await prompt({ title: 'New collection', label: 'Name', initial: 'My API', confirmLabel: 'Create' })
  if (name?.trim()) ws().createCollection(name.trim())
}

export async function createFolder(collectionId: string, parentId: string | null): Promise<void> {
  const name = await prompt({ title: 'New folder', label: 'Name', initial: 'New folder', confirmLabel: 'Create' })
  if (name?.trim()) ws().addFolder(collectionId, parentId, name.trim())
}

export async function createEnvironment(): Promise<void> {
  const name = await prompt({ title: 'New environment', label: 'Name', initial: 'Development', confirmLabel: 'Create' })
  if (!name?.trim()) return
  const id = ws().createEnvironment(name.trim())
  ws().openEnvironment(id)
}

export async function deleteItem(collectionId: string, itemId: string): Promise<void> {
  const c = ws().collections.find((x) => x.id === collectionId)
  if (!c) return
  const isCollection = collectionId === itemId
  const item = isCollection ? null : findItem(c, itemId)
  const name = isCollection ? c.name : item?.name
  const what = isCollection ? 'collection' : item?.kind === 'folder' ? 'folder' : 'request'
  const ok = await confirm({
    title: `Delete ${what}?`,
    message: `“${name}”${what !== 'request' ? ' and everything inside it' : ''} will be permanently deleted.`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (ok !== true) return
  if (isCollection) ws().deleteCollection(collectionId)
  else ws().deleteItem(collectionId, itemId)
}

export async function deleteEnvironment(id: string): Promise<void> {
  const e = ws().environments.find((x) => x.id === id)
  if (!e) return
  const ok = await confirm({
    title: 'Delete environment?',
    message: `“${e.name}” and its ${e.variables.length} variables will be permanently deleted.`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (ok === true) ws().deleteEnvironment(id)
}

export async function exportCollection(id: string, format: 'collection' | 'native'): Promise<void> {
  const c = ws().collections.find((x) => x.id === id)
  if (!c) return
  const data = format === 'collection' ? exportCollectionV21(c) : exportNative([c], [])
  const suffix = format === 'collection' ? '.collection.json' : '.ffcaller.json'
  const saved = await window.api.saveFile(safeFileName(c.name) + suffix, JSON.stringify(data, null, 2))
  if (saved) toast(`Exported “${c.name}”`, 'success')
}

export async function exportEnvironment(id: string): Promise<void> {
  const e = ws().environments.find((x) => x.id === id)
  if (!e) return
  const saved = await window.api.saveFile(
    safeFileName(e.name) + '.environment.json',
    JSON.stringify(exportEnvironmentFile(e), null, 2)
  )
  if (saved) toast(`Exported “${e.name}”`, 'success')
}

export async function exportEverything(): Promise<void> {
  const { collections, environments, flows } = ws()
  const saved = await window.api.saveFile(
    `flosforge-caller-backup-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(exportNative(collections, environments, flows), null, 2)
  )
  if (saved) toast('Backup exported', 'success')
}

// --- Workspaces --------------------------------------------------------------

/** Mid-tone presets (white reads on all of them), shared with FlosForge Reader. */
export const WORKSPACE_COLORS = ['#4F8EF7', '#2FB67C', '#E8A33D', '#E05C5C', '#9B6BE8', '#E86BB4', '#37B5C4', '#7A8794']

/** The first preset no other workspace uses, so new workspaces are told apart at a glance. */
export function nextWorkspaceColor(): string {
  const used = new Set(ws().workspaces.map((w) => w.color?.toUpperCase()))
  return WORKSPACE_COLORS.find((c) => !used.has(c)) ?? WORKSPACE_COLORS[ws().workspaces.length % WORKSPACE_COLORS.length]
}

let switching: Promise<void> | null = null

/** Saves everything pending, then loads the other workspace's data. */
export function switchWorkspace(id: string): Promise<void> {
  if (id === ws().activeWorkspaceId || switching) return switching ?? Promise.resolve()
  switching = (async () => {
    try {
      await flushPersistence()
      const data = await window.api.loadWorkspace(id)
      ws().loadWorkspaceData(id, data)
    } catch (e) {
      toast(`Could not open workspace: ${(e as Error).message}`, 'error')
    } finally {
      switching = null
    }
  })()
  return switching
}

export async function createWorkspace(name: string, color: string | null, inSidebar = false): Promise<void> {
  const id = ws().addWorkspace(name, color, inSidebar)
  await switchWorkspace(id)
  toast(`Switched to “${name}”`, 'success')
}

export async function deleteWorkspace(id: string): Promise<boolean> {
  const { workspaces, activeWorkspaceId } = ws()
  const target = workspaces.find((w) => w.id === id)
  if (!target || workspaces.length < 2) return false
  const ok = await confirm({
    title: 'Delete workspace?',
    message: `“${target.name}” and all of its collections, environments and history will be permanently deleted.`,
    confirmLabel: 'Delete workspace',
    danger: true
  })
  if (ok !== true) return false
  if (id === activeWorkspaceId) await switchWorkspace(workspaces.find((w) => w.id !== id)!.id)
  ws().removeWorkspace(id)
  await flushPersistence()
  await window.api.deleteWorkspace(id)
  toast(`Deleted “${target.name}”`)
  return true
}

/** Opens the demo workspace, creating it (with the Public API Tour) the first time. */
export async function openDemoWorkspace(): Promise<void> {
  const existing = ws().workspaces.find((w) => w.name === DEMO_WORKSPACE_NAME)
  if (existing) {
    await switchWorkspace(existing.id)
    return
  }
  const id = ws().addWorkspace(DEMO_WORKSPACE_NAME, DEMO_WORKSPACE_COLOR)
  await switchWorkspace(id)
  if (ws().activeWorkspaceId !== id) return
  const { collection, environment } = buildDemo()
  ws().importData({ collections: [collection], environments: [environment], globals: [], warnings: [] })
  ws().setActiveEnvironment(environment.id)
  const first = collection.items[0]
  if (first?.kind === 'folder') {
    ws().setExpanded(first.id, true)
    if (first.items[0]) ws().openRequest(collection.id, first.items[0].id)
  }
  toast('Demo workspace ready: work through the folders, top to bottom', 'success')
}

// --- Variables -------------------------------------------------------------------

/** From the response's Tree view: adds a capture of the value at `path` to the tab's request. */
export async function captureFromResponse(tabId: string, path: JsonPath): Promise<void> {
  const tab = ws().tabs.find((t) => t.id === tabId)
  if (tab?.kind !== 'request') return
  const where = formatJsonPath(path)
  const suggested = nameForPath(path)
  const name = (
    await prompt({ title: 'Capture into a variable', label: `Each send sets this variable from ${where}`, initial: suggested, placeholder: 'token', confirmLabel: 'Add capture' })
  )
    ?.trim()
    .replace(/^\{\{\s*|\s*\}\}$/g, '')
  if (!name) return
  const scope = ws().activeEnvironmentId ? 'environment' : tab.collectionId ? 'collection' : 'local'
  ws().updateDraft(tabId, (r) => {
    r.captures = [...(r.captures ?? []), newCapture({ variable: name, path: where, scope })]
  })
  toast(`Added a capture for {{${name}}} in the Capture tab. Save the request to keep it.`, 'success')
}

/** Where a variable value can be written. `tab` is temporary: in memory, for one tab. */
export type VariableTarget = 'environment' | 'collection' | 'globals' | 'tab'

function upsert(list: Variable[], name: string, value: string, secret?: boolean): void {
  const existing = list.find((v) => v.key === name && v.enabled) ?? list.find((v) => v.key === name)
  if (existing) {
    existing.value = value
    existing.enabled = true
    if (secret !== undefined) existing.secret = secret || undefined
  } else list.push(variable(name, value, true, !!secret))
}

export function saveVariable(opts: {
  name: string
  value: string
  target: VariableTarget
  collectionId?: string | null
  tabId?: string | null
  secret?: boolean
}): boolean {
  const { name, value, target, secret } = opts
  if (!name.trim()) return false
  switch (target) {
    case 'environment': {
      const envId = ws().activeEnvironmentId
      if (!envId) return false
      ws().updateEnvironment(envId, (e) => upsert(e.variables, name, value, secret))
      return true
    }
    case 'collection':
      if (!opts.collectionId) return false
      ws().updateCollection(opts.collectionId, (c) => upsert(c.variables, name, value, secret))
      return true
    case 'globals':
      ws().updateGlobals((g) => upsert(g, name, value, secret))
      return true
    case 'tab':
      if (!opts.tabId) return false
      useRuntime.getState().setTabVar(opts.tabId, name, value)
      return true
  }
}

/** One place a variable is defined. */
export type VariableScope = { kind: 'globals' } | { kind: 'environment'; id: string } | { kind: 'collection'; id: string }

function updateScope(scope: VariableScope, recipe: (vars: Variable[]) => void): void {
  if (scope.kind === 'globals') ws().updateGlobals(recipe)
  else if (scope.kind === 'environment') ws().updateEnvironment(scope.id, (e) => recipe(e.variables))
  else ws().updateCollection(scope.id, (c) => recipe(c.variables))
}

export function setScopeVariable(scope: VariableScope, name: string, value: string): void {
  updateScope(scope, (vars) => upsert(vars, name, value))
}

export function removeScopeVariable(scope: VariableScope, name: string): void {
  updateScope(scope, (vars) => {
    for (let i = vars.length - 1; i >= 0; i--) if (vars[i].key === name) vars.splice(i, 1)
  })
}

const VARIABLE_NAME = /^[^{}\s][^{}]*$/

export async function renameVariableEverywhere(name: string, uses: number): Promise<void> {
  const next = (await prompt({ title: `Rename {{${name}}}`, label: 'New name', initial: name, confirmLabel: 'Rename' }))?.trim()
  if (!next || next === name) return
  if (!VARIABLE_NAME.test(next)) return toast('A variable name can’t contain { or } or start with a space', 'error')
  const { globals, environments, collections } = ws()
  if ([globals, ...environments.map((e) => e.variables), ...collections.map((c) => c.variables)].some((vars) => vars.some((v) => v.key === next)))
    return toast(`There is already a variable named “${next}”`, 'error')
  ws().renameVariable(name, next)
  toast(`Renamed {{${name}}} to {{${next}}}${uses ? ` in ${uses} place${uses === 1 ? '' : 's'}` : ''}`, 'success')
}

export async function deleteVariableEverywhere(name: string): Promise<void> {
  const ok = await confirm({
    title: `Delete {{${name}}}?`,
    message: 'It will be removed from globals, every environment and every collection. Requests that use it keep their references.',
    confirmLabel: 'Delete everywhere',
    danger: true
  })
  if (ok === true) ws().deleteVariable(name)
}
