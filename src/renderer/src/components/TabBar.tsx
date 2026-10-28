import { useEffect, useRef, useState } from 'react'
import { Braces, Globe2, Layers, Library, Folder, Plus, X, Eye, Play, Workflow } from 'lucide-react'
import { activeEnvironment, activeTab, useWorkspace, type Tab } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { closeTab, closeTabs } from '../lib/actions'
import { contextFor } from '../lib/runner'
import { toMap, type Scopes } from '@shared/engine/variables'
import { findItem } from '@shared/tree'
import { MethodBadge, openMenu, modKey } from './ui'

function useTabTitle(tab: Tab): string {
  return useWorkspace((s) => {
    switch (tab.kind) {
      case 'request':
        return tab.draft.name
      case 'collection':
        return s.collections.find((c) => c.id === tab.collectionId)?.name ?? 'Collection'
      case 'folder': {
        const c = s.collections.find((x) => x.id === tab.collectionId)
        return (c && findItem(c, tab.itemId)?.name) ?? 'Folder'
      }
      case 'environment':
        return s.environments.find((e) => e.id === tab.environmentId)?.name ?? 'Environment'
      case 'globals':
        return 'Globals'
      case 'variables':
        return 'All variables'
      case 'flow':
        return s.flows.find((f) => f.id === tab.flowId)?.name ?? 'Flow'
      case 'runner': {
        const c = s.collections.find((x) => x.id === tab.collectionId)
        const folder = c && tab.folderId ? findItem(c, tab.folderId)?.name : undefined
        return `Run · ${folder ?? c?.name ?? 'collection'}`
      }
    }
  })
}

const ICONS: Record<Exclude<Tab['kind'], 'request'>, React.ReactNode> = {
  collection: <Library size={13} />,
  folder: <Folder size={13} />,
  environment: <Layers size={13} />,
  globals: <Globe2 size={13} />,
  variables: <Braces size={13} />,
  flow: <Workflow size={13} />,
  runner: <Play size={13} />
}

function TabItem({ tab, active }: { tab: Tab; active: boolean }) {
  const title = useTabTitle(tab)
  const sending = useRuntime((s) => !!s.sending[tab.id])
  const setActive = useWorkspace((s) => s.setActiveTab)
  const pin = useWorkspace((s) => s.pinTab)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const dirty = tab.kind === 'request' && tab.dirty
  const preview = tab.kind === 'request' && tab.preview

  return (
    <div
      ref={ref}
      className={`tab ${active ? 'active' : ''} ${preview ? 'preview' : ''}`}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void closeTab(tab.id)
        } else if (e.button === 0) setActive(tab.id)
      }}
      onDoubleClick={() => pin(tab.id)}
      onContextMenu={(e) => {
        const all = useWorkspace.getState().tabs
        openMenu(e, [
          { label: 'Close', onClick: () => void closeTab(tab.id), shortcut: `${modKey}+W` },
          { label: 'Close others', onClick: () => void closeTabs(all.filter((t) => t.id !== tab.id).map((t) => t.id)) },
          {
            label: 'Close to the right',
            onClick: () => void closeTabs(all.slice(all.findIndex((t) => t.id === tab.id) + 1).map((t) => t.id))
          },
          { label: 'Close all', onClick: () => void closeTabs(all.map((t) => t.id)) },
          ...(tab.kind === 'request'
            ? [
                { separator: true as const },
                {
                  label: 'Duplicate as new request',
                  onClick: () =>
                    useWorkspace.getState().openScratch({ ...structuredClone(tab.draft), id: crypto.randomUUID(), name: `${tab.draft.name} copy` })
                }
              ]
            : [])
        ])
      }}
      title={preview ? `${title} (preview — double-click to keep open)` : title}
    >
      {tab.kind === 'request' ? <MethodBadge method={tab.draft.method} short /> : <span className="tab-icon">{ICONS[tab.kind]}</span>}
      <span className="tab-title">{title}</span>
      {sending && <span className="tab-sending" />}
      <span className="tab-end">
        {dirty && <span className="dirty-dot" />}
        <button
          className="tab-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void closeTab(tab.id)
          }}
          aria-label="Close tab"
        >
          <X size={13} />
        </button>
      </span>
    </div>
  )
}

export function TabBar() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeId = useWorkspace((s) => s.activeTabId)
  const openScratch = useWorkspace((s) => s.openScratch)
  return (
    <div className="tabbar">
      <div className="tabs-scroll">
        {tabs.map((t) => (
          <TabItem key={t.id} tab={t} active={t.id === activeId} />
        ))}
        <button className="icon-btn new-tab" onClick={() => openScratch()} title={`New request (${modKey}+N)`}>
          <Plus size={16} />
        </button>
      </div>
      <EnvironmentSwitcher />
    </div>
  )
}

function EnvironmentSwitcher() {
  const environments = useWorkspace((s) => s.environments)
  const activeId = useWorkspace((s) => s.activeEnvironmentId)
  const setActive = useWorkspace((s) => s.setActiveEnvironment)
  const openEnvironment = useWorkspace((s) => s.openEnvironment)
  return (
    <div className="env-switcher">
      <Layers size={14} className={activeId ? 'env-on' : 'muted'} />
      <select value={activeId ?? ''} onChange={(e) => setActive(e.target.value || null)} title="Active environment">
        <option value="">No environment</option>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <VariablesPeek onOpenEnvironment={() => activeId && openEnvironment(activeId)} />
    </div>
  )
}

/** The eye button: what each {{variable}} resolves to for the open tab, and where the value comes from. */
function VariablesPeek({ onOpenEnvironment }: { onOpenEnvironment: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="vars-peek-host" ref={ref}>
      <button className={`icon-btn ${open ? 'active' : ''}`} onClick={() => setOpen(!open)} title="Variables in effect">
        <Eye size={14} />
      </button>
      {open && <VariablesPeekPanel close={() => setOpen(false)} onOpenEnvironment={onOpenEnvironment} />}
    </div>
  )
}

const PEEK_SOURCES = ['local', 'environment', 'collection', 'globals'] as const

function VariablesPeekPanel({ close, onOpenEnvironment }: { close: () => void; onOpenEnvironment: () => void }) {
  // Subscribing to these re-renders the panel when any value changes.
  const tab = useWorkspace(activeTab)
  const env = useWorkspace(activeEnvironment)
  const collections = useWorkspace((s) => s.collections)
  const globals = useWorkspace((s) => s.globals)
  useRuntime((s) => s.tabVars)
  const openVariables = useWorkspace((s) => s.openVariables)

  const request = tab?.kind === 'request' ? tab : null
  const collection = request?.collectionId ? collections.find((c) => c.id === request.collectionId) : undefined
  const scopes: Scopes = request
    ? contextFor(request).scopes
    : { globals: toMap(globals), collection: {}, environment: toMap(env?.variables), data: {}, local: {} }
  const secret = new Set(
    [...globals, ...(env?.variables ?? []), ...(collection?.variables ?? [])].filter((v) => v.secret).map((v) => v.key)
  )
  const label: Record<(typeof PEEK_SOURCES)[number], string> = {
    local: 'This tab',
    environment: env?.name ?? 'Environment',
    collection: collection?.name ?? 'Collection',
    globals: 'Globals'
  }
  const names = [...new Set(PEEK_SOURCES.flatMap((s) => Object.keys(scopes[s])))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )

  return (
    <div className="vars-peek">
      <div className="vars-peek-head">
        <strong>Variables in effect</strong>
        <span className="muted small">
          {request ? `for “${request.draft.name}”` : 'globals and the active environment'}
          {env ? ` · ${env.name}` : ' · no environment'}
        </span>
      </div>
      <div className="vars-peek-list">
        {names.length === 0 && <p className="hint pad">No variables have a value here.</p>}
        {names.map((name) => {
          const from = PEEK_SOURCES.filter((s) => name in scopes[s])
          const value = scopes[from[0]][name]
          return (
            <div key={name} className="vars-peek-row" title={from.length > 1 ? `Also in: ${from.slice(1).map((s) => label[s]).join(', ')} (overridden)` : undefined}>
              <code className="vars-var">{name}</code>
              <span className="vars-peek-value">{secret.has(name) ? '••••••' : value === '' ? <span className="muted">empty</span> : value}</span>
              <span className={`vars-source src-${from[0]}`}>
                {label[from[0]]}
                {from.length > 1 && <span className="muted"> +{from.length - 1}</span>}
              </span>
            </div>
          )
        })}
      </div>
      <div className="vars-peek-foot">
        {env && (
          <button
            className="btn ghost small"
            onClick={() => {
              onOpenEnvironment()
              close()
            }}
          >
            Edit {env.name}
          </button>
        )}
        <div className="spacer" />
        <button
          className="btn secondary small"
          onClick={() => {
            openVariables()
            close()
          }}
        >
          All variables
        </button>
      </div>
    </div>
  )
}
