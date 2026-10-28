import { useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Braces,
  Check,
  Clock,
  Cookie,
  Copy,
  Globe2,
  Import,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Share,
  Trash2,
  Play,
  Workflow,
} from 'lucide-react'
import { useWorkspace, type SidebarPanel } from '../../store/workspace'
import { useDialogs, confirm } from '../../store/dialogs'
import { createCollection, createEnvironment, deleteEnvironment, exportEnvironment } from '../../lib/actions'
import { statusTone, timeAgo } from '../../lib/format'
import { buildVariableReport } from '@shared/variableUsage'
import { runFlowById } from '../../lib/flowRunner'
import { CollectionTree } from './CollectionTree'
import { Empty, InlineEdit, MethodBadge, Splitter, openMenu } from '../ui'
import { WorkspaceBadges, WorkspaceHeader } from './WorkspaceSwitcher'

export function Rail() {
  const panel = useWorkspace((s) => s.sidebarPanel)
  const visible = useWorkspace((s) => s.sidebarVisible)
  const setPanel = useWorkspace((s) => s.setSidebarPanel)
  const openModal = useDialogs((s) => s.openModal)
  const item = (id: SidebarPanel, icon: React.ReactNode, label: string) => (
    <button className={`rail-btn ${visible && panel === id ? 'active' : ''}`} onClick={() => setPanel(id)} title={label}>
      {icon}
      <span className="rail-label">{label}</span>
    </button>
  )
  return (
    <nav className="rail">
      <WorkspaceBadges />
      {item('collections', <Library size={19} />, 'Library')}
      {item('variables', <Braces size={19} />, 'Variables')}
      {item('flows', <Workflow size={19} />, 'Flows')}
      {item('history', <Clock size={19} />, 'History')}
      <div className="spacer" />
      <button className="rail-btn" onClick={() => openModal('cookies')} title="Cookie jar">
        <Cookie size={19} />
      </button>
      <button className="rail-btn" onClick={() => openModal('settings')} title="Settings">
        <Settings size={19} />
      </button>
    </nav>
  )
}

/** The app mark, matching the FlosForge family: dark squircle, teal request arrow and response dot. */
export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <defs>
        <linearGradient id={`${id}m`} x1="0" y1="0" x2="200" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#14202B" />
          <stop offset="1" stopColor="#0A0E13" />
        </linearGradient>
        <linearGradient id={`${id}a`} x1="40" y1="60" x2="160" y2="140" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#0891B2" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="198" height="198" rx="44" fill={`url(#${id}m)`} stroke="#24333F" strokeWidth="2" />
      <path
        d="M44 100H122M96 72l28 28-28 28"
        stroke={`url(#${id}a)`}
        strokeWidth="13"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="152" cy="100" r="9" fill="#2DD4BF" />
      <path d="M60 146h44M60 54h28" stroke="#2DD4BF" strokeOpacity=".35" strokeWidth="6" strokeLinecap="round" />
    </svg>
  )
}

export function Sidebar() {
  const panel = useWorkspace((s) => s.sidebarPanel)
  const width = useWorkspace((s) => s.sidebarWidth)
  const setWidth = useWorkspace((s) => s.setSidebarWidth)
  const [start, setStart] = useState(width)
  return (
    <aside className="sidebar" style={{ width }}>
      <WorkspaceHeader />
      {panel === 'collections' && <CollectionsPanel />}
      {panel === 'variables' && <VariablesPanel />}
      {panel === 'flows' && <FlowsPanel />}
      {panel === 'history' && <HistoryPanel />}
      <Splitter direction="vertical" onStart={() => setStart(width)} onDrag={(d) => setWidth(start + d)} />
    </aside>
  )
}

function PanelHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-header">
      <span className="panel-title">{title}</span>
      <div className="panel-actions">{children}</div>
    </div>
  )
}

function CollectionsPanel() {
  const count = useWorkspace((s) => s.collections.length)
  const openModal = useDialogs((s) => s.openModal)
  const [filter, setFilter] = useState('')
  return (
    <div className="panel">
      <PanelHeader title="Library">
        <button className="icon-btn" onClick={() => openModal('import')} title="Import a collection, environment or cURL command">
          <Import size={15} />
        </button>
        <button className="icon-btn" onClick={() => void createCollection()} title="New collection">
          <Plus size={16} />
        </button>
      </PanelHeader>
      {count > 0 && (
        <div className="panel-search">
          <Search size={13} />
          <input placeholder="Filter requests" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="panel-body">
        {count === 0 ? (
          <Empty icon={<Library size={30} strokeWidth={1.4} />} title="Your library is empty">
            <p>Collections group related requests, with shared auth, scripts and variables.</p>
            <div className="empty-actions">
              <button className="btn primary small" onClick={() => void createCollection()}>
                <Plus size={14} /> New collection
              </button>
              <button className="btn secondary small" onClick={() => openModal('import')}>
                <Import size={14} /> Import a collection
              </button>
            </div>
          </Empty>
        ) : (
          <CollectionTree filter={filter} />
        )}
      </div>
    </div>
  )
}

/** Every variable in one place: an overview, globals, environments and each collection's variables. */
function VariablesPanel() {
  const environments = useWorkspace((s) => s.environments)
  const collections = useWorkspace((s) => s.collections)
  const globals = useWorkspace((s) => s.globals)
  const flows = useWorkspace((s) => s.flows)
  const activeId = useWorkspace((s) => s.activeEnvironmentId)
  const globalsCount = globals.length
  const problems = useMemo(
    () => buildVariableReport(collections, environments, globals, null, flows).filter((r) => r.undefinedUse || r.missingIn.length).length,
    [collections, environments, globals, flows]
  )
  const store = useWorkspace.getState
  const openModal = useDialogs((s) => s.openModal)
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <div className="panel">
      <PanelHeader title="Variables">
        <button className="icon-btn" onClick={() => openModal('import')} title="Import an environment">
          <Import size={15} />
        </button>
        <button className="icon-btn" onClick={() => void createEnvironment()} title="New environment">
          <Plus size={16} />
        </button>
      </PanelHeader>
      <div className="panel-body">
        <div className="env-list">
          <div className="env-row globals" onClick={() => store().openVariables()} title="Every variable in one table: values per scope, which one wins, where each is used">
            <Braces size={14} className="tree-icon" />
            <span className="tree-name">All variables</span>
            {problems > 0 && (
              <span className="vars-problems" title={`${problems} variable${problems === 1 ? '' : 's'} with problems`}>
                <AlertTriangle size={11} /> {problems}
              </span>
            )}
          </div>
          <div className="env-row globals" onClick={() => store().openGlobals()}>
            <Globe2 size={14} className="tree-icon" />
            <span className="tree-name">Globals</span>
            <span className="tree-count">{globalsCount}</span>
          </div>
          <div className="panel-section">Environments</div>
          {environments.map((e) => (
            <div
              key={e.id}
              className={`env-row ${activeId === e.id ? 'active' : ''}`}
              onClick={() => store().openEnvironment(e.id)}
              onContextMenu={(ev) =>
                openMenu(ev, [
                  {
                    label: activeId === e.id ? 'Deactivate' : 'Set active',
                    icon: <Check size={14} />,
                    onClick: () => store().setActiveEnvironment(activeId === e.id ? null : e.id)
                  },
                  { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(e.id) },
                  { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateEnvironment(e.id) },
                  { label: 'Export environment', icon: <Share size={14} />, onClick: () => void exportEnvironment(e.id) },
                  { separator: true },
                  { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteEnvironment(e.id) }
                ])
              }
            >
              <button
                className={`env-radio ${activeId === e.id ? 'on' : ''}`}
                title={activeId === e.id ? 'Active — click to deactivate' : 'Set as active environment'}
                onClick={(ev) => {
                  ev.stopPropagation()
                  store().setActiveEnvironment(activeId === e.id ? null : e.id)
                }}
              />
              {renaming === e.id ? (
                <InlineEdit
                  value={e.name}
                  onCommit={(name) => {
                    store().updateEnvironment(e.id, (env) => void (env.name = name))
                    setRenaming(null)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="tree-name">{e.name}</span>
              )}
              <span className="tree-count">{e.variables.length}</span>
              <button
                className="icon-btn subtle row-action"
                onClick={(ev) =>
                  openMenu(ev, [
                    { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(e.id) },
                    { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateEnvironment(e.id) },
                    { label: 'Export environment', icon: <Share size={14} />, onClick: () => void exportEnvironment(e.id) },
                    { separator: true },
                    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteEnvironment(e.id) }
                  ])
                }
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
          ))}
          {environments.length === 0 && (
            <Empty title="No environments">
              <p>
                Environments hold variables like <code>{'{{baseUrl}}'}</code> so you can switch between local, staging and
                production.
              </p>
              <button className="btn primary small" onClick={() => void createEnvironment()}>
                <Plus size={14} /> New environment
              </button>
            </Empty>
          )}
          {collections.length > 0 && <div className="panel-section">Collection variables</div>}
          {collections.map((c) => (
            <div key={c.id} className="env-row" onClick={() => store().openItemSettings(c.id, c.id)} title={`Variables of “${c.name}”`}>
              <Library size={14} className="tree-icon collection-icon" />
              <span className="tree-name">{c.name}</span>
              <span className="tree-count">{c.variables.length}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Saved chains of library requests. */
function FlowsPanel() {
  const flows = useWorkspace((s) => s.flows)
  const store = useWorkspace.getState
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div className="panel">
      <PanelHeader title="Flows">
        <button className="icon-btn" onClick={() => store().createFlow()} title="New flow">
          <Plus size={16} />
        </button>
      </PanelHeader>
      <div className="panel-body">
        <div className="env-list">
          {flows.map((f) => (
            <div
              key={f.id}
              className="env-row"
              onClick={() => store().openFlow(f.id)}
              onContextMenu={(ev) => openMenu(ev, flowMenu(f.id, () => setRenaming(f.id)))}
            >
              <Workflow size={14} className="tree-icon" />
              {renaming === f.id ? (
                <InlineEdit
                  value={f.name}
                  onCommit={(name) => {
                    store().updateFlow(f.id, (x) => void (x.name = name))
                    setRenaming(null)
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="tree-name">{f.name}</span>
              )}
              <span className="tree-count">{f.steps.length}</span>
              <button className="icon-btn subtle row-action" onClick={(ev) => openMenu(ev, flowMenu(f.id, () => setRenaming(f.id)))}>
                <MoreHorizontal size={14} />
              </button>
            </div>
          ))}
          {flows.length === 0 && (
            <Empty icon={<Workflow size={30} strokeWidth={1.4} />} title="No flows yet">
              <p>
                A flow chains requests from your library: log in, use the token, create something, poll until it’s ready.
                Values pass from step to step through captures, with no scripts.
              </p>
              <button className="btn primary small" onClick={() => store().createFlow()}>
                <Plus size={14} /> New flow
              </button>
            </Empty>
          )}
        </div>
      </div>
    </div>
  )
}

function flowMenu(id: string, rename: () => void) {
  const store = useWorkspace.getState
  return [
    {
      label: 'Run',
      icon: <Play size={14} />,
      onClick: () => {
        store().openFlow(id)
        void runFlowById(id)
      }
    },
    { label: 'Rename', icon: <Pencil size={14} />, onClick: rename },
    { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateFlow(id) },
    { separator: true as const },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        const f = store().flows.find((x) => x.id === id)
        const ok = await confirm({ title: 'Delete flow?', message: `“${f?.name}” will be deleted. Its requests stay in the library.`, confirmLabel: 'Delete', danger: true })
        if (ok === true) store().deleteFlow(id)
      }
    }
  ]
}

function HistoryPanel() {
  const history = useWorkspace((s) => s.history)
  const store = useWorkspace.getState
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const q = filter.toLowerCase()
    const out = new Map<string, typeof history>()
    for (const h of history) {
      if (q && !h.resolvedUrl.toLowerCase().includes(q) && !h.request.name.toLowerCase().includes(q)) continue
      const d = new Date(h.at)
      const today = new Date()
      const key =
        d.toDateString() === today.toDateString()
          ? 'Today'
          : d.toDateString() === new Date(Date.now() - 864e5).toDateString()
            ? 'Yesterday'
            : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      if (!out.has(key)) out.set(key, [])
      out.get(key)!.push(h)
    }
    return [...out.entries()]
  }, [history, filter])

  return (
    <div className="panel">
      <PanelHeader title="History">
        {history.length > 0 && (
          <button
            className="icon-btn"
            title="Clear history"
            onClick={async () => {
              const ok = await confirm({ title: 'Clear history?', message: 'All history entries will be removed.', confirmLabel: 'Clear', danger: true })
              if (ok === true) store().clearHistory()
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </PanelHeader>
      {history.length > 0 && (
        <div className="panel-search">
          <Search size={13} />
          <input placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="panel-body">
        {history.length === 0 && <Empty icon={<Clock size={30} strokeWidth={1.4} />} title="Nothing sent yet">Every request you send is listed here.</Empty>}
        {groups.map(([day, entries]) => (
          <div key={day} className="history-group">
            <div className="history-day">{day}</div>
            {entries.map((h) => (
              <div
                key={h.id}
                className="history-row"
                title={h.resolvedUrl}
                onClick={() => store().openScratch({ ...structuredClone(h.request), id: crypto.randomUUID() })}
                onContextMenu={(e) =>
                  openMenu(e, [{ label: 'Remove', icon: <Trash2 size={14} />, danger: true, onClick: () => store().removeHistory(h.id) }])
                }
              >
                <MethodBadge method={h.request.method} short />
                <span className="history-url">{h.resolvedUrl.replace(/^https?:\/\//, '')}</span>
                <span className={`history-status ${h.status ? `tone-${statusTone(h.status)}` : 'tone-server'}`}>
                  {h.status ?? 'ERR'}
                </span>
                <span className="history-time">{timeAgo(h.at)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
