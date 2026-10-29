import { useState } from 'react'
import type { AskVariablesTarget } from '../../store/dialogs'
import { useDialogs } from '../../store/dialogs'
import { Modal } from '../ui'
import { ImportModal } from './ImportModal'
import { SaveAsModal } from './SaveAsModal'
import { SettingsModal } from './SettingsModal'
import { CodegenModal } from './CodegenModal'
import { CookiesModal } from './CookiesModal'
import { WorkspaceModal } from './WorkspaceModal'
import { VariableModal } from './VariableModal'

export function DialogHost() {
  const modal = useDialogs((s) => s.modal)
  const pending = useDialogs((s) => s.pending)
  const toast = useDialogs((s) => s.toast)

  return (
    <>
      {modal?.name === 'import' && <ImportModal />}
      {modal?.name === 'settings' && <SettingsModal section={modal.props?.section as never} />}
      {modal?.name === 'cookies' && <CookiesModal />}
      {modal?.name === 'workspace' && <WorkspaceModal id={modal.props?.id as string | undefined} />}
      {modal?.name === 'variable' && (
        <VariableModal
          key={modal.props?.name as string}
          name={modal.props?.name as string}
          collectionId={(modal.props?.collectionId as string | null) ?? null}
          tabId={(modal.props?.tabId as string | null) ?? null}
        />
      )}
      {modal?.name === 'codegen' && <CodegenModal tabId={modal.props?.tabId as string} />}
      {modal?.name === 'saveAs' && (
        <SaveAsModal tabId={modal.props?.tabId as string} closeAfter={!!modal.props?.closeAfter} />
      )}
      {pending?.kind === 'prompt' && <PromptDialog key={`prompt-${pending.id}`} />}
      {pending?.kind === 'confirm' && <ConfirmDialog key={`confirm-${pending.id}`} />}
      {pending?.kind === 'variables' && <AskVariablesDialog key={`vars-${pending.id}`} />}
      {toast && (
        // Keys are prefixed: siblings share one key space, and these ids all start at 1.
        <div key={`toast-${toast.id}`} className={`toast toast-${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </>
  )
}

function PromptDialog() {
  const pending = useDialogs((s) => s.pending)
  const close = useDialogs((s) => s.close)
  const [value, setValue] = useState(pending?.kind === 'prompt' ? (pending.opts.initial ?? '') : '')
  if (pending?.kind !== 'prompt') return null
  const { opts, resolve } = pending
  const done = (v: string | null) => {
    close()
    resolve(v)
  }
  return (
    <Modal
      title={opts.title}
      onClose={() => done(null)}
      width={420}
      footer={
        <>
          <button className="btn ghost" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => done(value)} disabled={!value.trim()}>
            {opts.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      {opts.label && <label className="field-label">{opts.label}</label>}
      <input
        className="text-input"
        autoFocus
        value={value}
        placeholder={opts.placeholder}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && done(value)}
      />
    </Modal>
  )
}

function ConfirmDialog() {
  const pending = useDialogs((s) => s.pending)
  const close = useDialogs((s) => s.close)
  if (pending?.kind !== 'confirm') return null
  const { opts, resolve } = pending
  const done = (v: boolean | 'alt') => {
    close()
    resolve(v)
  }
  return (
    <Modal
      title={opts.title}
      onClose={() => done(false)}
      width={440}
      footer={
        <>
          <button className="btn ghost" onClick={() => done(false)}>
            Cancel
          </button>
          {opts.altLabel && (
            <button className="btn secondary" onClick={() => done('alt')}>
              {opts.altLabel}
            </button>
          )}
          <button className={`btn ${opts.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => done(true)}>
            {opts.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <p className="confirm-message">{opts.message}</p>
    </Modal>
  )
}

let lastAskTarget: AskVariablesTarget = 'once'

/** Shown when sending a request whose {{variables}} have no value yet. */
function AskVariablesDialog() {
  const pending = useDialogs((s) => s.pending)
  const close = useDialogs((s) => s.close)
  const opts = pending?.kind === 'variables' ? pending.opts : null
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((opts?.names ?? []).map((n) => [n, '']))
  )
  const targets: { id: AskVariablesTarget; label: string }[] = [
    { id: 'once', label: 'This send only' },
    { id: 'tab', label: 'This tab, until it closes' },
    ...(opts?.environmentName ? [{ id: 'environment' as const, label: `Environment “${opts.environmentName}”` }] : []),
    ...(opts?.collectionName ? [{ id: 'collection' as const, label: `Collection “${opts.collectionName}”` }] : []),
    { id: 'globals', label: 'Globals' }
  ]
  const [target, setTarget] = useState<AskVariablesTarget>(
    targets.some((t) => t.id === lastAskTarget) ? lastAskTarget : 'once'
  )
  if (pending?.kind !== 'variables' || !opts) return null
  const done = (answer: Parameters<typeof pending.resolve>[0]) => {
    close()
    pending.resolve(answer)
  }
  const send = () => {
    lastAskTarget = target
    done({ action: 'send', values, target })
  }
  return (
    <Modal
      title="Missing variables"
      onClose={() => done(null)}
      width={520}
      footer={
        <>
          <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => done({ action: 'skip' })}>
            Send without them
          </button>
          <button className="btn ghost" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={send}>
            Send
          </button>
        </>
      }
    >
      <p className="confirm-message">This request uses variables that have no value yet.</p>
      <div className="ask-vars">
        {opts.names.map((n, i) => (
          <label key={n} className="ask-var">
            <code>{`{{${n}}}`}</code>
            <input
              className="text-input"
              autoFocus={i === 0}
              value={values[n] ?? ''}
              onChange={(e) => setValues({ ...values, [n]: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
          </label>
        ))}
      </div>
      <label className="field-label" style={{ marginTop: 14 }}>
        Use these values for
      </label>
      <div className="var-targets">
        {targets.map((t) => (
          <label key={t.id} className="var-target">
            <input type="radio" name="ask-target" checked={target === t.id} onChange={() => setTarget(t.id)} />
            <span>{t.label}</span>
          </label>
        ))}
      </div>
      <p className="hint">Turn this prompt off in Settings → Requests.</p>
    </Modal>
  )
}
