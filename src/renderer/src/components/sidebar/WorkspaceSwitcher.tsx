import { ChevronsUpDown, Compass, Plus, Settings, Settings2 } from 'lucide-react'
import { activeWorkspace, useWorkspace } from '../../store/workspace'
import { useDialogs } from '../../store/dialogs'
import { openDemoWorkspace, switchWorkspace } from '../../lib/actions'
import { contrastInk } from '../../theme/apply'
import { openMenu, type MenuItem } from '../ui'

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

/** The workspace's colour, or the live accent when it follows the theme. */
export const workspaceFill = (color: string | null): string => color ?? 'var(--accent)'
const workspaceInk = (color: string | null): string => (color ? contrastInk(color) : 'var(--accent-contrast)')

function useWorkspaceMenu(): (e: React.MouseEvent) => void {
  const workspaces = useWorkspace((s) => s.workspaces)
  const activeId = useWorkspace((s) => s.activeWorkspaceId)
  const openModal = useDialogs((s) => s.openModal)
  return (e) => {
    const items: MenuItem[] = [
      ...workspaces.map((w) => ({
        label: w.name,
        icon: <span className="ws-dot" style={{ background: workspaceFill(w.color) }} />,
        shortcut: w.id === activeId ? '✓' : undefined,
        onClick: () => void switchWorkspace(w.id)
      })),
      { separator: true },
      { label: 'New workspace…', icon: <Plus size={14} />, onClick: () => openModal('workspace') },
      { label: 'Open the demo workspace', icon: <Compass size={14} />, onClick: () => void openDemoWorkspace() },
      { label: 'Workspace settings…', icon: <Settings2 size={14} />, onClick: () => openModal('workspace', { id: activeId }) }
    ]
    openMenu(e, items)
  }
}

/** Top of the rail: the current workspace as a coloured badge. */
export function WorkspaceBadges() {
  const workspaces = useWorkspace((s) => s.workspaces)
  const activeId = useWorkspace((s) => s.activeWorkspaceId)
  const open = useWorkspaceMenu()
  // The open workspace always shows; the others when "Show in the sidebar" is on. Kept in list order.
  const shown = workspaces.filter((w) => w.inSidebar || w.id === activeId)
  if (!shown.length) return null
  return (
    <div className={`ws-badges ${shown.length > 1 ? 'several' : ''}`}>
      {shown.map((w) => {
        const active = w.id === activeId
        return (
          <button
            key={w.id}
            className={`ws-badge ${active ? 'active' : ''}`}
            style={{ background: workspaceFill(w.color), color: workspaceInk(w.color), ['--ws-fill' as string]: workspaceFill(w.color) }}
            onClick={active ? open : () => void switchWorkspace(w.id)}
            onContextMenu={open}
            title={active ? `Workspace: ${w.name} (click to switch)` : `Switch to ${w.name}`}
          >
            {initials(w.name)}
          </button>
        )
      })}
    </div>
  )
}

/** Top of the sidebar: the current workspace's name (a switcher) and its settings. */
export function WorkspaceHeader() {
  const ws = useWorkspace(activeWorkspace)
  const count = useWorkspace((s) => s.collections.length)
  const openModal = useDialogs((s) => s.openModal)
  const open = useWorkspaceMenu()
  if (!ws) return null
  return (
    <div className="ws-header-row">
    <button className="ws-header" onClick={open} title="Switch workspace">
      <span className="ws-dot large" style={{ background: workspaceFill(ws.color) }} />
      <span className="ws-header-text">
        <span className="ws-header-name">{ws.name}</span>
        <span className="ws-header-sub">
          {count} collection{count === 1 ? '' : 's'}
        </span>
      </span>
      <ChevronsUpDown size={14} className="muted" />
    </button>
    <button
      className="ws-header ws-settings"
      onClick={() => openModal('workspace', { id: ws.id })}
      title="Workspace settings"
      aria-label="Workspace settings"
    >
      <Settings size={16} />
    </button>
    </div>
  )
}
