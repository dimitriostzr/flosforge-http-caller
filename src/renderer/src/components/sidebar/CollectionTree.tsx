import { memo, useMemo, useState } from 'react'
import {
  ChevronRight,
  Copy,
  FilePlus2,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Library,
  MoreHorizontal,
  Pencil,
  Play,
  Settings2,
  Share,
  Trash2
} from 'lucide-react'
import type { Collection, Folder, TreeItem } from '@shared/types'
import { activeTab, useWorkspace, type WorkspaceStore } from '../../store/workspace'
import { countRequests } from '@shared/tree'
import { createFolder, deleteItem, exportCollection } from '../../lib/actions'
import { exportTreeItem } from '../../lib/exports'
import { InlineEdit, MethodBadge, openMenu, type MenuItem } from '../ui'

type DropZone = 'before' | 'after' | 'inside'
let dragging: { collectionId: string; itemId: string } | null = null

function matches(item: TreeItem, q: string): boolean {
  if (item.name.toLowerCase().includes(q)) return true
  if (item.kind === 'request') return item.url.toLowerCase().includes(q)
  return item.items.some((i) => matches(i, q))
}

/**
 * What rows need from the rest of the store. Read here with one subscription
 * rather than several per row: with thousands of rows, per-row subscriptions
 * made every keystroke in a request run thousands of selectors.
 */
interface RowState {
  activeId: string | null
  dirty: ReadonlySet<string>
  expanded: Record<string, boolean>
}

const activeItemId = (s: WorkspaceStore): string | null => {
  const t = activeTab(s)
  return t?.kind === 'request' ? t.requestId : t?.kind === 'folder' ? t.itemId : null
}

/** Ids of saved requests with unsaved edits, as a string so it only changes when the set does. */
const dirtyIds = (s: WorkspaceStore): string =>
  s.tabs
    .filter((t) => t.kind === 'request' && t.dirty && t.requestId)
    .map((t) => (t.kind === 'request' ? t.requestId : ''))
    .join('\n')

export function CollectionTree({ filter }: { filter: string }) {
  const collections = useWorkspace((s) => s.collections)
  const activeId = useWorkspace(activeItemId)
  const dirty = useWorkspace(dirtyIds)
  const expanded = useWorkspace((s) => s.expanded)
  const rows = useMemo<RowState>(
    () => ({ activeId, dirty: new Set(dirty ? dirty.split('\n') : []), expanded }),
    [activeId, dirty, expanded]
  )
  const q = filter.trim().toLowerCase()
  const shown = q ? collections.filter((c) => c.name.toLowerCase().includes(q) || c.items.some((i) => matches(i, q))) : collections
  return (
    <div className="tree" role="tree">
      {shown.map((c) => (
        <CollectionNode key={c.id} c={c} q={q} rows={rows} />
      ))}
    </div>
  )
}

/** Child rows. Only folders get the shared row state; requests get just their own flags, so they skip re-rendering. */
function childNodes(items: TreeItem[], c: Collection, parentId: string | null, depth: number, q: string, rows: RowState) {
  return items.map((it, i) => (
    <ItemNode
      key={it.id}
      item={it}
      c={c}
      parentId={parentId}
      index={i}
      depth={depth}
      q={q}
      active={rows.activeId === it.id}
      dirty={rows.dirty.has(it.id)}
      expanded={!!rows.expanded[it.id]}
      rows={it.kind === 'folder' ? rows : undefined}
    />
  ))
}

function CollectionNode({ c, q, rows }: { c: Collection; q: string; rows: RowState }) {
  const expanded = !!rows.expanded[c.id]
  const store = useWorkspace.getState
  const [renaming, setRenaming] = useState(false)
  const [drop, setDrop] = useState<DropZone | null>(null)
  const open = expanded || !!q

  const menu: MenuItem[] = [
    { label: 'New request', icon: <FilePlus2 size={14} />, onClick: () => store().addRequest(c.id, null) },
    { label: 'New folder', icon: <FolderPlus size={14} />, onClick: () => void createFolder(c.id, null) },
    { separator: true },
    { label: 'Run collection…', icon: <Play size={14} />, onClick: () => store().openRunner(c.id, null) },
    { label: 'Settings, auth & variables', icon: <Settings2 size={14} />, onClick: () => store().openItemSettings(c.id, c.id) },
    { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
    { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateCollection(c.id) },
    { label: 'Export collection (v2.1 JSON)', icon: <Share size={14} />, onClick: () => void exportCollection(c.id, 'collection') },
    { label: 'Export as backup', icon: <Share size={14} />, onClick: () => void exportCollection(c.id, 'native') },
    { separator: true },
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteItem(c.id, c.id) }
  ]

  return (
    <div role="treeitem" aria-expanded={open}>
      <div
        className={`tree-row collection-row ${drop === 'inside' ? 'drop-inside' : ''}`}
        style={{ paddingLeft: 6 }}
        onClick={() => store().setExpanded(c.id, !expanded)}
        onDoubleClick={() => store().openItemSettings(c.id, c.id)}
        onContextMenu={(e) => openMenu(e, menu)}
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          setDrop('inside')
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault()
          setDrop(null)
          if (dragging) store().moveItem(dragging.collectionId, dragging.itemId, c.id, null)
          dragging = null
        }}
      >
        <ChevronRight size={14} className={`chev ${open ? 'open' : ''}`} />
        <Library size={14} className="tree-icon collection-icon" />
        {renaming ? (
          <InlineEdit
            value={c.name}
            onCommit={(n) => {
              store().renameItem(c.id, c.id, n)
              setRenaming(false)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="tree-name">{c.name}</span>
        )}
        <span className="tree-count">{countRequests(c.items)}</span>
        <button className="icon-btn subtle row-action" onClick={(e) => openMenu(e, menu)} title="More">
          <MoreHorizontal size={14} />
        </button>
      </div>
      {open && (
        <div role="group">
          {childNodes(c.items, c, null, 1, q, rows)}
          {c.items.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 }}>
              Empty —{' '}
              <button className="link" onClick={() => store().addRequest(c.id, null)}>
                add a request
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ItemNode = memo(function ItemNode({
  item,
  c,
  parentId,
  index,
  depth,
  q,
  active: isActive,
  dirty,
  expanded,
  rows
}: {
  item: TreeItem
  c: Collection
  parentId: string | null
  index: number
  depth: number
  q: string
  active: boolean
  dirty: boolean
  expanded: boolean
  /** Folders only: passed on to their children. */
  rows?: RowState
}) {
  const store = useWorkspace.getState
  const [renaming, setRenaming] = useState(false)
  const [drop, setDrop] = useState<DropZone | null>(null)

  if (q && !matches(item, q)) return null
  const isFolder = item.kind === 'folder'
  const open = isFolder && (expanded || !!q)

  const menu: MenuItem[] = isFolder
    ? [
        { label: 'New request', icon: <FilePlus2 size={14} />, onClick: () => store().addRequest(c.id, item.id) },
        { label: 'New folder', icon: <FolderPlus size={14} />, onClick: () => void createFolder(c.id, item.id) },
        { separator: true },
        { label: 'Run folder…', icon: <Play size={14} />, onClick: () => store().openRunner(c.id, item.id) },
        { label: 'Settings, auth & scripts', icon: <Settings2 size={14} />, onClick: () => store().openItemSettings(c.id, item.id) },
        { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
        { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateItem(c.id, item.id) },
        { label: 'Export folder (collection v2.1)', icon: <Share size={14} />, onClick: () => void exportTreeItem(c.id, item.id, 'collection') },
        { label: 'Export folder (FlosForge Caller)', icon: <Share size={14} />, onClick: () => void exportTreeItem(c.id, item.id, 'native') },
        { separator: true },
        { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteItem(c.id, item.id) }
      ]
    : [
        { label: 'Open in new tab', icon: <FilePlus2 size={14} />, onClick: () => store().openRequest(c.id, item.id) },
        { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
        { label: 'Duplicate', icon: <Copy size={14} />, onClick: () => store().duplicateItem(c.id, item.id) },
        { label: 'Export as collection (v2.1)', icon: <Share size={14} />, onClick: () => void exportTreeItem(c.id, item.id, 'collection') },
        { label: 'Export as FlosForge Caller file', icon: <Share size={14} />, onClick: () => void exportTreeItem(c.id, item.id, 'native') },
        { label: 'Export as cURL', icon: <Share size={14} />, onClick: () => void exportTreeItem(c.id, item.id, 'curl') },
        { separator: true },
        { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteItem(c.id, item.id) }
      ]

  const zoneFor = (e: React.DragEvent): DropZone => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    if (isFolder) return y < 0.25 ? 'before' : y > 0.75 && !open ? 'after' : 'inside'
    return y < 0.5 ? 'before' : 'after'
  }

  return (
    <div role="treeitem" aria-expanded={isFolder ? open : undefined}>
      <div
        className={`tree-row ${isActive ? 'active' : ''} ${drop ? `drop-${drop}` : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          dragging = { collectionId: c.id, itemId: item.id }
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', item.name)
        }}
        onDragEnd={() => {
          dragging = null
          setDrop(null)
        }}
        onDragOver={(e) => {
          if (!dragging || dragging.itemId === item.id) return
          e.preventDefault()
          e.stopPropagation()
          setDrop(zoneFor(e))
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const zone = zoneFor(e)
          setDrop(null)
          if (!dragging) return
          if (zone === 'inside') store().moveItem(dragging.collectionId, dragging.itemId, c.id, item.id)
          else store().moveItem(dragging.collectionId, dragging.itemId, c.id, parentId, zone === 'before' ? index : index + 1)
          dragging = null
        }}
        onClick={() =>
          isFolder ? store().setExpanded(item.id, !expanded) : store().openRequest(c.id, item.id, { preview: true })
        }
        onDoubleClick={() => (isFolder ? store().openItemSettings(c.id, item.id) : store().openRequest(c.id, item.id))}
        onContextMenu={(e) => openMenu(e, menu)}
      >
        {isFolder ? (
          <>
            <ChevronRight size={14} className={`chev ${open ? 'open' : ''}`} />
            {open ? <FolderOpen size={14} className="tree-icon" /> : <FolderIcon size={14} className="tree-icon" />}
          </>
        ) : (
          <MethodBadge method={item.method} short />
        )}
        {renaming ? (
          <InlineEdit
            value={item.name}
            onCommit={(n) => {
              store().renameItem(c.id, item.id, n)
              setRenaming(false)
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="tree-name" title={item.kind === 'request' ? item.url : item.name}>
            {item.name}
          </span>
        )}
        {dirty && <span className="dirty-dot" title="Unsaved changes" />}
        <button className="icon-btn subtle row-action" onClick={(e) => openMenu(e, menu)} title="More">
          <MoreHorizontal size={14} />
        </button>
      </div>
      {open && (
        <div role="group">
          {rows && childNodes((item as Folder).items, c, item.id, depth + 1, q, rows)}
          {(item as Folder).items.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
              Empty folder
            </div>
          )}
        </div>
      )}
    </div>
  )
})
