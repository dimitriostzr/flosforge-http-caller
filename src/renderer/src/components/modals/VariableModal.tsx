import { useState } from 'react'
import { activeEnvironment, useWorkspace } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { toast, useDialogs } from '../../store/dialogs'
import { saveVariable, type VariableTarget } from '../../lib/actions'
import { toMap } from '@shared/engine/variables'
import { Modal } from '../ui'

interface Props {
  name: string
  collectionId: string | null
  tabId: string | null
}

/** Set a {{variable}} from wherever it is used: pick the value and where it lives. */
export function VariableModal({ name, collectionId, tabId }: Props) {
  const close = useDialogs((s) => s.closeModal)
  const env = useWorkspace(activeEnvironment)
  const collection = useWorkspace((s) => s.collections.find((c) => c.id === collectionId))
  const globals = useWorkspace((s) => s.globals)
  const tabVars = useRuntime((s) => (tabId ? s.tabVars[tabId] : undefined))
  const clearTabVar = useRuntime((s) => s.setTabVar)

  // Highest precedence first, matching how values are resolved when sending.
  const sources: { target: VariableTarget; label: string; value?: string; available: boolean; note?: string }[] = [
    { target: 'tab', label: 'This tab only', value: tabVars?.[name], available: !!tabId, note: 'temporary, not saved' },
    {
      target: 'environment',
      label: env ? `Environment “${env.name}”` : 'Environment',
      value: env ? toMap(env.variables)[name] : undefined,
      available: !!env,
      note: env ? undefined : 'no environment is active'
    },
    {
      target: 'collection',
      label: collection ? `Collection “${collection.name}”` : 'Collection',
      value: collection ? toMap(collection.variables)[name] : undefined,
      available: !!collection,
      note: collection ? undefined : 'request is not in a collection'
    },
    { target: 'globals', label: 'Globals', value: toMap(globals)[name], available: true }
  ]
  const winner = sources.find((s) => s.value !== undefined)
  const defaultTarget = winner?.target ?? sources.find((s) => s.available && s.target !== 'tab')!.target

  const [value, setValue] = useState(winner?.value ?? '')
  const [target, setTarget] = useState<VariableTarget>(defaultTarget)
  const [secret, setSecret] = useState(false)

  const save = () => {
    if (!saveVariable({ name, value, target, collectionId, tabId, secret })) return
    const where = sources.find((s) => s.target === target)!.label
    toast(`{{${name}}} set in ${where.replace(/“|”/g, '')}`, 'success')
    close()
  }

  return (
    <Modal
      title={
        <>
          Variable <code>{`{{${name}}}`}</code>
        </>
      }
      onClose={close}
      width={520}
      footer={
        <>
          {tabVars?.[name] !== undefined && tabId && (
            <button
              className="btn ghost"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                clearTabVar(tabId, name, null)
                close()
              }}
            >
              Remove temporary value
            </button>
          )}
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <table className="data-table compact var-sources">
        <tbody>
          {sources.map((s) => (
            <tr key={s.target} className={s === winner ? 'winner' : ''}>
              <td className="data-key">{s.label}</td>
              <td className="data-value">
                {s.value !== undefined ? s.value || <span className="muted">(empty)</span> : <span className="muted">—</span>}
              </td>
              <td className="small nowrap">{s === winner ? <span className="var-used">used</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">The first scope that defines the variable wins, from the top.</p>

      <label className="field-label" style={{ marginTop: 12 }}>
        Value
      </label>
      <textarea
        className="text-input var-value"
        value={value}
        autoFocus
        rows={value.length > 60 ? 4 : 1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            save()
          }
        }}
      />

      <label className="field-label" style={{ marginTop: 12 }}>
        Save to
      </label>
      <div className="var-targets">
        {sources.map((s) => (
          <label key={s.target} className={`var-target ${!s.available ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="var-target"
              disabled={!s.available}
              checked={target === s.target}
              onChange={() => setTarget(s.target)}
            />
            <span>{s.label}</span>
            {s.note && <span className="muted small">{s.note}</span>}
          </label>
        ))}
      </div>
      {target !== 'tab' && (
        <label className="check-label small" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> Mask the value (secret)
        </label>
      )}
    </Modal>
  )
}
