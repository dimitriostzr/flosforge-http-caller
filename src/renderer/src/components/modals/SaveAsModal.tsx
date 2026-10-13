import { useState } from 'react'
import { ChevronRight, Folder, Library, Plus } from 'lucide-react'
import type { TreeItem } from '@shared/types'
import { useWorkspace } from '../../store/workspace'
import { toast, useDialogs } from '../../store/dialogs'
import { Modal } from '../ui'

/** Asks where to save a scratch request: name + collection/folder. */
export function SaveAsModal({ tabId, closeAfter }: { tabId: string; closeAfter?: boolean }) {
  const close = useDialogs((s) => s.closeModal)
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === tabId))
  const collections = useWorkspace((s) => s.collections)
  const store = useWorkspace.getState
  const [name, setName] = useState(tab?.kind === 'request' ? tab.draft.name : '')
  const [target, setTarget] = useState<{ collectionId: string; folderId: string | null } | null>(
    collections[0] ? { collectionId: collections[0].id, folderId: null } : null
  )
  const [newCollection, setNewCollection] = useState(collections.length === 0 ? 'My API' : '')

  if (tab?.kind !== 'request') return null

  const save = () => {
    let dest = target
    if (newCollection.trim() && (!dest || collections.length === 0)) {
      dest = { collectionId: store().createCollection(newCollection.trim()), folderId: null }
    }
    if (!dest || !name.trim()) return
    store().saveTabAs(tabId, dest.collectionId, dest.folderId, name.trim())
    toast('Saved', 'success')
    close()
    if (closeAfter) store().closeTab(tabId)
  }

  const renderFolders = (items: TreeItem[], collectionId: string, depth: number): React.ReactNode =>
    items
      .filter((i) => i.kind === 'folder')
      .map((f) => (
        <div key={f.id}>
          <div
            className={`pick-row ${target?.folderId === f.id ? 'active' : ''}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            onClick={() => setTarget({ collectionId, folderId: f.id })}
          >
            <Folder size={14} /> {f.name}
          </div>
          {f.kind === 'folder' && renderFolders(f.items, collectionId, depth + 1)}
        </div>
      ))

  return (
    <Modal
      title="Save request"
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!name.trim() || (!target && !newCollection.trim())}>
            Save
          </button>
        </>
      }
    >
      <label className="field-label">Name</label>
      <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
      <label className="field-label" style={{ marginTop: 14 }}>
        Save to
      </label>
      {collections.length > 0 ? (
        <div className="pick-tree">
          {collections.map((c) => (
            <div key={c.id}>
              <div
                className={`pick-row ${target?.collectionId === c.id && !target.folderId ? 'active' : ''}`}
                onClick={() => setTarget({ collectionId: c.id, folderId: null })}
              >
                <ChevronRight size={12} className="muted" />
                <Library size={14} className="collection-icon" /> {c.name}
              </div>
              {renderFolders(c.items, c.id, 1)}
            </div>
          ))}
        </div>
      ) : (
        <div className="new-collection-inline">
          <Plus size={14} />
          <input
            className="text-input"
            value={newCollection}
            onChange={(e) => setNewCollection(e.target.value)}
            placeholder="New collection name"
          />
        </div>
      )}
    </Modal>
  )
}
