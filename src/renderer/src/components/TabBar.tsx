import { useEffect, useRef } from 'react'
import { Globe2, Layers, Library, Folder, Plus, X, Eye, Play } from 'lucide-react'
import { useWorkspace, type Tab } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { closeTab, closeTabs } from '../lib/actions'
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
      <button
        className="icon-btn"
        disabled={!activeId}
        onClick={() => activeId && openEnvironment(activeId)}
        title="View active environment"
      >
        <Eye size={14} />
      </button>
    </div>
  )
}
