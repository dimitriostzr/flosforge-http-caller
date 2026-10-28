import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Braces, Eye, EyeOff, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import type { Variable } from '@shared/types'
import { USAGE_LABELS, buildVariableReport, winningScope, type VariableRow, type VariableUsage } from '@shared/variableUsage'
import { activeTab, useWorkspace } from '../../store/workspace'
import { prompt, useDialogs } from '../../store/dialogs'
import {
  deleteVariableEverywhere,
  removeScopeVariable,
  renameVariableEverywhere,
  setScopeVariable,
  type VariableScope
} from '../../lib/actions'
import { Empty, openMenu, type MenuItem } from '../ui'

type Filter = 'all' | 'problems'

/** The collection a new overview shows: the one of the request you were on, else the first. */
function defaultCollectionId(): string | null {
  const s = useWorkspace.getState()
  const recent = [activeTab(s), ...s.tabs].find((t) => t && 'collectionId' in t && t.collectionId)
  const id = recent && 'collectionId' in recent ? recent.collectionId : null
  return s.collections.some((c) => c.id === id) ? id : (s.collections[0]?.id ?? null)
}

const hasProblem = (r: VariableRow): boolean => r.undefinedUse || r.missingIn.length > 0

export function VariablesOverview() {
  const collections = useWorkspace((s) => s.collections)
  const environments = useWorkspace((s) => s.environments)
  const globals = useWorkspace((s) => s.globals)
  const flows = useWorkspace((s) => s.flows)
  const activeEnvId = useWorkspace((s) => s.activeEnvironmentId)
  const setActiveEnv = useWorkspace((s) => s.setActiveEnvironment)
  const openModal = useDialogs((s) => s.openModal)
  const [collectionId, setCollectionId] = useState<string | null>(defaultCollectionId)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [reveal, setReveal] = useState(false)

  const collection = collections.find((c) => c.id === collectionId) ?? collections[0]
  const rows = useMemo(
    () => buildVariableReport(collections, environments, globals, collection?.id ?? null, flows),
    [collections, environments, globals, collection?.id, flows]
  )
  const problems = rows.filter(hasProblem).length
  const q = query.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      (filter === 'all' || hasProblem(r)) &&
      (!q ||
        r.name.toLowerCase().includes(q) ||
        [r.globals, r.collection, ...Object.values(r.environments)].some((v) => v && !v.secret && v.value.toLowerCase().includes(q)))
  )

  const addVariable = async () => {
    const name = (await prompt({ title: 'New variable', label: 'Name', placeholder: 'baseUrl', confirmLabel: 'Next' }))?.trim()
    if (name) openModal('variable', { name: name.replace(/^\{\{|\}\}$/g, ''), collectionId: collection?.id ?? null, tabId: null })
  }

  return (
    <div className="settings-view">
      <div className="settings-header">
        <Braces size={18} />
        <h2>All variables</h2>
        <span className="muted small">
          {rows.length} variable{rows.length === 1 ? '' : 's'}
        </span>
        <div className="spacer" />
        <button className="btn ghost small" onClick={() => setReveal(!reveal)} title="Show or hide secret values">
          {reveal ? <EyeOff size={13} /> : <Eye size={13} />} {reveal ? 'Hide secrets' : 'Show secrets'}
        </button>
        <button className="btn primary small" onClick={() => void addVariable()}>
          <Plus size={14} /> Add variable
        </button>
      </div>

      <div className="vars-toolbar">
        <div className="panel-search inline">
          <Search size={13} />
          <input placeholder="Filter by name or value" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'problems' ? 'active' : ''} onClick={() => setFilter('problems')}>
            Problems{problems ? ` (${problems})` : ''}
          </button>
        </div>
        {collections.length > 0 && (
          <label className="vars-pick" title="Whose collection variables the Collection column shows">
            <span className="muted small">Collection</span>
            <select className="select" value={collection?.id} onChange={(e) => setCollectionId(e.target.value)}>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {rows.length === 0 ? (
        <Empty icon={<Braces size={30} strokeWidth={1.4} />} title="No variables yet">
          Variables hold values like <code>{'{{baseUrl}}'}</code> or a token, so requests don’t repeat them. Add one here, or
          hover a <code>{'{{name}}'}</code> in a request to give it a value.
        </Empty>
      ) : (
        <div className="vars-scroll">
          {/* Fixed layout: value columns share the width and long values end in an ellipsis. */}
          <table className="vars-table" style={{ minWidth: 220 + 110 + 36 + (environments.length + (collection ? 2 : 1)) * 140 }}>
            <colgroup>
              <col style={{ width: 220 }} />
              <col />
              {collection && <col />}
              {environments.map((e) => (
                <col key={e.id} />
              ))}
              <col style={{ width: 110 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <thead>
              <tr>
                <th className="vars-name">Name</th>
                <th>Globals</th>
                {collection && <th title={collection.name}>Collection · {collection.name}</th>}
                {environments.map((e) => (
                  <th key={e.id} className={e.id === activeEnvId ? 'active-env' : ''}>
                    <button
                      className="vars-env-head"
                      onClick={() => setActiveEnv(e.id === activeEnvId ? null : e.id)}
                      title={e.id === activeEnvId ? 'Active environment: click to deactivate' : 'Click to make this the active environment'}
                    >
                      <span className={`env-radio ${e.id === activeEnvId ? 'on' : ''}`} />
                      {e.name}
                    </button>
                  </th>
                ))}
                <th className="vars-used">Used in</th>
                <th className="vars-actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Row
                  key={r.name}
                  row={r}
                  collectionId={collection?.id ?? null}
                  environments={environments}
                  activeEnvId={activeEnvId}
                  reveal={reveal}
                />
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="hint pad">Nothing matches.</p>}
          <p className="hint pad">
            When a name is defined in several places, a request uses the active environment’s value, then its collection’s,
            then the global one. The value in use is highlighted. Click a cell to edit it, or an empty one to add a value
            there. Temporary values for one tab, and data-file columns in a run, win over all of these.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({
  row,
  collectionId,
  environments,
  activeEnvId,
  reveal
}: {
  row: VariableRow
  collectionId: string | null
  environments: { id: string; name: string }[]
  activeEnvId: string | null
  reveal: boolean
}) {
  const winner = winningScope(row, activeEnvId)
  const anyDefinition = !!row.globals || !!row.collection || Object.values(row.environments).some(Boolean)
  const cell = (scope: VariableScope, v: Variable | undefined, state: CellState) => (
    <ValueCell
      variable={v}
      state={state}
      masked={!!v?.secret && !reveal}
      onCommit={(value) => setScopeVariable(scope, row.name, value)}
      onRemove={() => removeScopeVariable(scope, row.name)}
    />
  )
  // Lower scopes are overridden by the winner; they're still sent nowhere for this collection.
  const stateFor = (scope: 'environment' | 'collection' | 'globals', v: Variable | undefined, envId?: string): CellState => {
    if (!v) return envId && row.missingIn.includes(envId) ? 'missing' : 'empty'
    if (!v.enabled) return 'disabled'
    if (scope === 'environment') return envId === activeEnvId ? 'wins' : 'other-env'
    return winner === scope ? 'wins' : 'overridden'
  }

  return (
    <tr className={hasProblem(row) ? 'has-problem' : ''}>
      <td className="vars-name">
        <code className="vars-var">{row.name}</code>
        <span className="vars-badges">
          {row.undefinedUse && (
            <span className="vars-badge bad" title="Used in a request, but no scope defines it and no script or capture sets it">
              <AlertTriangle size={11} /> not defined
            </span>
          )}
          {row.missingIn.length > 0 && (
            <span
              className="vars-badge warn"
              title={`Missing in: ${row.missingIn.map((id) => environments.find((e) => e.id === id)?.name).join(', ')}`}
            >
              missing in {row.missingIn.length} env{row.missingIn.length === 1 ? '' : 's'}
            </span>
          )}
          {row.setByScript && (
            <span className="vars-badge" title="A capture or a script (pm.environment.set() and similar) sets it when the request runs">
              set at run time
            </span>
          )}
          {row.unused && <span className="vars-badge muted">unused</span>}
        </span>
      </td>
      <td>{cell({ kind: 'globals' }, row.globals, stateFor('globals', row.globals))}</td>
      {collectionId && <td>{cell({ kind: 'collection', id: collectionId }, row.collection, stateFor('collection', row.collection))}</td>}
      {environments.map((e) => (
        <td key={e.id} className={e.id === activeEnvId ? 'active-env' : ''}>
          {cell({ kind: 'environment', id: e.id }, row.environments[e.id], stateFor('environment', row.environments[e.id], e.id))}
        </td>
      ))}
      <td className="vars-used">
        {row.usages.length > 0 ? (
          <button className="btn ghost small" onClick={(ev) => openMenu(ev, usageMenu(row.usages))}>
            {usageSummary(row.usages)}
          </button>
        ) : (
          <span className="muted small">—</span>
        )}
      </td>
      <td className="vars-actions">
        <button
          className="icon-btn subtle"
          title="More"
          onClick={(ev) =>
            openMenu(ev, [
              {
                label: 'Rename everywhere…',
                icon: <Pencil size={14} />,
                onClick: () => void renameVariableEverywhere(row.name, row.usages.length)
              },
              { separator: true },
              {
                label: 'Delete everywhere',
                icon: <Trash2 size={14} />,
                danger: true,
                disabled: !anyDefinition,
                onClick: () => void deleteVariableEverywhere(row.name)
              }
            ])
          }
        >
          <MoreHorizontal size={14} />
        </button>
      </td>
    </tr>
  )
}

/** "3 requests", or "2 places" when some uses are in folders, collections or other variables' values. */
function usageSummary(usages: VariableUsage[]): string {
  const reads = usages.filter((u) => !u.sets)
  const list = reads.length ? reads : usages
  const count = new Set(list.map((u) => u.itemId ?? u.label)).size
  const noun = list.every((u) => u.itemKind === 'request') ? 'request' : 'place'
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function usageMenu(usages: VariableUsage[]): MenuItem[] {
  const ws = useWorkspace.getState()
  return usages.map((u) => ({
    label: `${u.label} · ${USAGE_LABELS[u.where]}${u.sets ? ' (sets it)' : ''}`,
    disabled: !u.itemId || (!u.collectionId && u.itemKind !== 'flow'),
    onClick: () => {
      if (u.itemKind === 'flow' && u.itemId) return ws.openFlow(u.itemId)
      if (!u.itemId || !u.collectionId) return
      if (u.itemKind === 'request') ws.openRequest(u.collectionId, u.itemId)
      else ws.openItemSettings(u.collectionId, u.itemId)
    }
  }))
}

type CellState = 'wins' | 'overridden' | 'other-env' | 'disabled' | 'missing' | 'empty'

const CELL_TITLES: Record<CellState, string> = {
  wins: 'This is the value requests use',
  overridden: 'Overridden by a scope with higher precedence',
  'other-env': 'Used when this environment is active',
  disabled: 'Disabled: not used',
  missing: 'Other environments define it, this one doesn’t',
  empty: 'Click to add a value here'
}

function ValueCell({
  variable,
  state,
  masked,
  onCommit,
  onRemove
}: {
  variable: Variable | undefined
  state: CellState
  masked: boolean
  onCommit: (value: string) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (editing)
    return (
      <input
        ref={ref}
        className="vars-edit"
        value={draft}
        type={masked ? 'password' : 'text'}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(variable?.value ?? '')
            setEditing(false)
          }
        }}
        onBlur={() => {
          setEditing(false)
          // An empty cell left empty stays undefined; an existing value may be cleared on purpose.
          if (variable ? draft !== variable.value : draft !== '') onCommit(draft)
        }}
      />
    )

  return (
    <div className={`vars-cell st-${state}`} title={CELL_TITLES[state]}>
      <button
        className="vars-value"
        onClick={() => {
          setDraft(variable?.value ?? '')
          setEditing(true)
        }}
      >
        {variable ? (
          variable.value === '' ? (
            <span className="muted">empty</span>
          ) : masked ? (
            '••••••'
          ) : (
            variable.value
          )
        ) : state === 'missing' ? (
          <span className="vars-missing">missing</span>
        ) : (
          <span className="vars-none">—</span>
        )}
      </button>
      {variable && (
        <button className="icon-btn subtle vars-remove" title="Remove from here" onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </div>
  )
}
