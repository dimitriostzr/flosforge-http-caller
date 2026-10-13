import { useState } from 'react'
import { Check, Palette, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../store/workspace'
import { useDialogs } from '../../store/dialogs'
import { WORKSPACE_COLORS, createWorkspace, deleteWorkspace, nextWorkspaceColor } from '../../lib/actions'
import { contrastInk } from '../../theme/apply'
import { Modal } from '../ui'

/** Create a workspace (no id) or edit one. */
export function WorkspaceModal({ id }: { id?: string }) {
  const close = useDialogs((s) => s.closeModal)
  const existing = useWorkspace((s) => s.workspaces.find((w) => w.id === id))
  const count = useWorkspace((s) => s.workspaces.length)
  const update = useWorkspace((s) => s.updateWorkspace)
  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState<string | null>(existing ? existing.color : nextWorkspaceColor())
  const isCustom = !!color && !WORKSPACE_COLORS.includes(color.toUpperCase())

  const save = async () => {
    const n = name.trim()
    if (!n) return
    close()
    if (existing) update(existing.id, { name: n, color })
    else await createWorkspace(n, color)
  }

  return (
    <Modal
      title={existing ? 'Workspace settings' : 'New workspace'}
      onClose={close}
      width={460}
      footer={
        <>
          {existing && count > 1 && (
            <button
              className="btn ghost danger-text"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                if (await deleteWorkspace(existing.id)) close()
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={!name.trim()}>
            {existing ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <label className="field-label">Name</label>
      <input
        className="text-input"
        value={name}
        autoFocus
        placeholder="e.g. Work, Side project, Client X"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      />

      <label className="field-label" style={{ marginTop: 16 }}>
        Accent colour
      </label>
      <div className="color-row">
        <button
          className={`color-swatch theme-swatch ${color === null ? 'selected' : ''}`}
          title="Follow the theme's accent"
          onClick={() => setColor(null)}
        >
          {color === null && <Check size={14} strokeWidth={3} />}
        </button>
        {WORKSPACE_COLORS.map((c) => (
          <button
            key={c}
            className={`color-swatch ${color?.toUpperCase() === c ? 'selected' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => setColor(c)}
          >
            {color?.toUpperCase() === c && <Check size={14} strokeWidth={3} />}
          </button>
        ))}
        <label
          className={`color-swatch custom ${isCustom ? 'selected' : ''}`}
          style={isCustom ? { background: color!, color: contrastInk(color!) } : undefined}
          title="Pick any colour"
        >
          {isCustom ? <Check size={14} strokeWidth={3} /> : <Palette size={14} />}
          <input type="color" value={color ?? '#4F8EF7'} onChange={(e) => setColor(e.target.value.toUpperCase())} />
        </label>
      </div>
      <p className="hint">
        {color === null
          ? 'Uses the accent of the current theme.'
          : 'Buttons, tabs and highlights use this colour while the workspace is open, whatever the theme.'}
      </p>
      {!existing && (
        <p className="hint">A new workspace starts empty: its own collections, environments, globals and history.</p>
      )}
    </Modal>
  )
}
