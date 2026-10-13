import { useState } from 'react'
import { Eye, EyeOff, Library, Folder as FolderIcon, Layers, Globe2, Play } from 'lucide-react'
import { variable } from '@shared/model'
import type { Auth, Collection, Folder, Scripts, Variable } from '@shared/types'
import { useWorkspace, type EnvironmentTab, type ItemSettingsTab } from '../store/workspace'
import { findItem, countRequests } from '@shared/tree'
import { useScopes } from '../lib/useScopes'
import { VarScopesContext } from './editor/variables'
import { CodeEditor } from './editor/CodeEditor'
import { KeyValueEditor } from './KeyValueEditor'
import { AuthEditor } from './request/AuthEditor'
import { ScriptsEditor } from './request/ScriptsEditor'
import { Empty, InlineEdit, Tabs } from './ui'

type SettingsTab = 'overview' | 'auth' | 'scripts' | 'variables'

export function ItemSettingsView({ tab }: { tab: ItemSettingsTab }) {
  const collection = useWorkspace((s) => s.collections.find((c) => c.id === tab.collectionId))
  const updateCollection = useWorkspace((s) => s.updateCollection)
  const renameItem = useWorkspace((s) => s.renameItem)
  const scopesRef = useScopes(tab.collectionId)
  const isCollection = tab.kind === 'collection'
  const [sub, setSub] = useState<SettingsTab>(isCollection ? 'variables' : 'auth')
  const [editingName, setEditingName] = useState(false)

  const target: Collection | Folder | null = !collection
    ? null
    : isCollection
      ? collection
      : (findItem(collection, tab.itemId) as Folder | null)
  if (!collection || !target) return <Empty title="Not found">This item no longer exists.</Empty>

  /** Applies a change to the collection or the folder inside it. */
  const edit = (recipe: (t: Collection | Folder) => void) =>
    updateCollection(collection.id, (c) => {
      const t = isCollection ? c : (findItem(c, tab.itemId) as Folder | null)
      if (t) recipe(t)
    })

  const tabs: { id: SettingsTab; label: string; badge?: number | string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'auth', label: 'Auth', badge: target.auth.type !== 'inherit' && target.auth.type !== 'none' ? '●' : undefined },
    { id: 'scripts', label: 'Scripts', badge: target.scripts.preRequest.trim() || target.scripts.test.trim() ? '●' : undefined },
    ...(isCollection ? [{ id: 'variables' as const, label: 'Variables', badge: (target as Collection).variables.length || undefined }] : [])
  ]

  return (
    <VarScopesContext.Provider value={scopesRef}>
      <div className="settings-view">
        <div className="settings-header">
          {isCollection ? <Library size={18} className="collection-icon" /> : <FolderIcon size={18} />}
          {editingName ? (
            <InlineEdit
              className="title-edit"
              value={target.name}
              onCommit={(n) => {
                renameItem(collection.id, target.id, n)
                setEditingName(false)
              }}
              onCancel={() => setEditingName(false)}
            />
          ) : (
            <h2 onDoubleClick={() => setEditingName(true)} title="Double-click to rename">
              {target.name}
            </h2>
          )}
          <span className="muted small">
            {isCollection ? 'Collection' : 'Folder'} · {countRequests(target.items)} requests
          </span>
          <div className="spacer" />
          <button
            className="btn primary small"
            onClick={() => useWorkspace.getState().openRunner(collection.id, isCollection ? null : target.id)}
            disabled={!countRequests(target.items)}
            title={`Run every request in this ${isCollection ? 'collection' : 'folder'}`}
          >
            <Play size={13} /> Run
          </button>
        </div>
        <Tabs value={sub} onChange={setSub} tabs={tabs} />
        <div className="settings-body">
          {sub === 'overview' && (
            <div className="overview">
              <label className="field-label">Description</label>
              <div className="description-editor">
                <CodeEditor
                  value={target.description}
                  onChange={(v) => edit((t) => void (t.description = v))}
                  lineNumbers={false}
                  placeholder="What is this for? Markdown welcome."
                />
              </div>
              <p className="hint">
                <Play size={12} /> Auth and scripts set here apply to every request inside {isCollection ? 'this collection' : 'this folder'} unless a
                request overrides them.
              </p>
            </div>
          )}
          {sub === 'auth' && (
            <div className="scroll-pad">
              <AuthEditor
                auth={target.auth}
                allowInherit={!isCollection}
                onChange={(a: Auth) => edit((t) => void (t.auth = a))}
                inheritedLabel={isCollection ? undefined : 'Uses the auth of the parent folder or collection.'}
              />
            </div>
          )}
          {sub === 'scripts' && (
            <ScriptsEditor
              scripts={target.scripts}
              onChange={(k: keyof Scripts, v) => edit((t) => void (t.scripts[k] = v))}
              scopeNote={`Runs for every request in this ${isCollection ? 'collection' : 'folder'}, before the request's own scripts.`}
            />
          )}
          {sub === 'variables' && isCollection && (
            <VariablesTable
              rows={(target as Collection).variables}
              onChange={(rows) => edit((t) => void ((t as Collection).variables = rows))}
              note="Collection variables are shared by all requests in this collection. Environment variables with the same name take precedence."
            />
          )}
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}

export function VariablesTable({ rows, onChange, note }: { rows: Variable[]; onChange: (rows: Variable[]) => void; note?: string }) {
  const [reveal, setReveal] = useState(false)
  const [bulk, setBulk] = useState(false)
  return (
    <div className="scroll-pad">
      <div className="kv-toolbar">
        <span className="hint">{note}</span>
        <button className="btn ghost small" onClick={() => setReveal(!reveal)} title="Show or hide secret values">
          {reveal ? <EyeOff size={13} /> : <Eye size={13} />} {reveal ? 'Hide secrets' : 'Show secrets'}
        </button>
        <button className="btn ghost small" onClick={() => setBulk(!bulk)}>
          {bulk ? 'Table view' : 'Bulk edit'}
        </button>
      </div>
      <KeyValueEditor<Variable>
        rows={rows}
        onChange={onChange}
        create={(id) => ({ ...variable(), id })}
        keyPlaceholder="variable"
        bulk={bulk}
        isMasked={(r) => !!r.secret && !reveal}
        extraHeader="Secret"
        renderExtra={(row, update) => (
          <input
            type="checkbox"
            checked={!!row.secret}
            onChange={(e) => update({ secret: e.target.checked })}
            title="Mask this value in the UI"
          />
        )}
      />
    </div>
  )
}

export function EnvironmentView({ tab }: { tab: EnvironmentTab }) {
  const env = useWorkspace((s) => s.environments.find((e) => e.id === tab.environmentId))
  const isActive = useWorkspace((s) => s.activeEnvironmentId === tab.environmentId)
  const update = useWorkspace((s) => s.updateEnvironment)
  const setActive = useWorkspace((s) => s.setActiveEnvironment)
  const scopesRef = useScopes(null)
  const [editingName, setEditingName] = useState(false)
  if (!env) return <Empty title="Not found">This environment was deleted.</Empty>
  return (
    <VarScopesContext.Provider value={scopesRef}>
      <div className="settings-view">
        <div className="settings-header">
          <Layers size={18} />
          {editingName ? (
            <InlineEdit
              className="title-edit"
              value={env.name}
              onCommit={(n) => {
                update(env.id, (e) => void (e.name = n))
                setEditingName(false)
              }}
              onCancel={() => setEditingName(false)}
            />
          ) : (
            <h2 onDoubleClick={() => setEditingName(true)} title="Double-click to rename">
              {env.name}
            </h2>
          )}
          <div className="spacer" />
          <button className={`btn small ${isActive ? 'secondary' : 'primary'}`} onClick={() => setActive(isActive ? null : env.id)}>
            {isActive ? 'Active ✓' : 'Set active'}
          </button>
        </div>
        <div className="settings-body">
          <VariablesTable
            rows={env.variables}
            onChange={(rows) => update(env.id, (e) => void (e.variables = rows))}
            note="Reference these anywhere as {{name}}. Changes save automatically."
          />
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}

export function GlobalsView() {
  const globals = useWorkspace((s) => s.globals)
  const updateGlobals = useWorkspace((s) => s.updateGlobals)
  const scopesRef = useScopes(null)
  return (
    <VarScopesContext.Provider value={scopesRef}>
      <div className="settings-view">
        <div className="settings-header">
          <Globe2 size={18} />
          <h2>Globals</h2>
        </div>
        <div className="settings-body">
          <VariablesTable
            rows={globals}
            onChange={(rows) => updateGlobals((g) => void g.splice(0, g.length, ...rows))}
            note="Available in every request regardless of environment. Lowest precedence."
          />
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}
