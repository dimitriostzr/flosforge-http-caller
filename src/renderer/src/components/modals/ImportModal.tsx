import { useState } from 'react'
import { AlertTriangle, CheckCircle2, FileJson, FolderOpen, ShieldAlert } from 'lucide-react'
import { importText, type ImportResult } from '@shared/importers'
import { importRisks, type ImportRisks } from '@shared/importers/risks'
import { useWorkspace } from '../../store/workspace'
import { toast, useDialogs } from '../../store/dialogs'
import { countRequests } from '@shared/tree'
import { Modal } from '../ui'

interface Summary {
  collections: { name: string; requests: number }[]
  environments: string[]
  globals: number
  flows: number
  request?: string
  warnings: string[]
  errors: string[]
}

function summarize(results: ImportResult[], errors: string[]): Summary {
  return {
    collections: results.flatMap((r) => r.collections.map((c) => ({ name: c.name, requests: countRequests(c.items) }))),
    environments: results.flatMap((r) => r.environments.map((e) => e.name)),
    globals: results.reduce((n, r) => n + r.globals.length, 0),
    flows: results.reduce((n, r) => n + (r.flows?.length ?? 0), 0),
    request: results.find((r) => r.request)?.request?.name,
    warnings: results.flatMap((r) => r.warnings),
    errors
  }
}

export function ImportModal() {
  const close = useDialogs((s) => s.closeModal)
  const importData = useWorkspace((s) => s.importData)
  const [text, setText] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [review, setReview] = useState<{ results: ImportResult[]; errors: string[]; risks: ImportRisks } | null>(null)

  const run = (inputs: { name?: string; content: string }[]) => {
    const results: ImportResult[] = []
    const errors: string[] = []
    for (const input of inputs) {
      try {
        results.push(importText(input.content, input.name))
      } catch (e) {
        errors.push(`${input.name ?? 'Pasted text'}: ${(e as Error).message}`)
      }
    }
    // Scripts and file uploads act on this computer: say so before anything is saved.
    const risks = importRisks(results)
    if (risks.scripts || risks.files.length) setReview({ results, errors, risks })
    else commit(results, errors)
  }

  const commit = (results: ImportResult[], errors: string[]) => {
    setReview(null)
    for (const r of results) importData(r)
    const s = summarize(results, errors)
    if (!s.warnings.length && !s.errors.length) {
      const parts = [
        s.collections.length && `${s.collections.length} collection${s.collections.length > 1 ? 's' : ''}`,
        s.environments.length && `${s.environments.length} environment${s.environments.length > 1 ? 's' : ''}`,
        s.globals && `${s.globals} globals`,
        s.flows && `${s.flows} flow${s.flows > 1 ? 's' : ''}`,
        s.request && 'a request'
      ].filter(Boolean)
      toast(`Imported ${parts.join(', ') || 'nothing'}`, 'success')
      close()
    } else setSummary(s)
  }

  const chooseFiles = async () => {
    const files = await window.api.openFiles('Import collections or environments')
    if (files.length) run(files)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...e.dataTransfer.files]
    run(await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))))
  }

  if (review) {
    const { scripts, files } = review.risks
    return (
      <Modal
        title="Before you import"
        onClose={close}
        width={560}
        footer={
          <>
            <button className="btn secondary" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => commit(review.results, review.errors)}>
              Import
            </button>
          </>
        }
      >
        <div className="import-summary">
          {scripts > 0 && (
            <div className="summary-row bad">
              <ShieldAlert size={15} /> {scripts} script{scripts > 1 ? 's' : ''}
            </div>
          )}
          {scripts > 0 && (
            <p className="muted small">
              Scripts run when you send these requests. They can read your variables, including secrets in the active
              environment, and send requests of their own with your cookies and certificates.
            </p>
          )}
          {files.length > 0 && (
            <div className="summary-row bad">
              <ShieldAlert size={15} /> {files.length} file upload{files.length > 1 ? 's' : ''} from your computer
            </div>
          )}
          {files.length > 0 && (
            <>
              <ul className="summary-warnings">
                {files.slice(0, 5).map((f) => (
                  <li key={f}>{f}</li>
                ))}
                {files.length > 5 && <li>and {files.length - 5} more</li>}
              </ul>
              <p className="muted small">You'll be asked before any of these files is sent.</p>
            </>
          )}
          <p className="small">Only import collections from people you trust.</p>
        </div>
      </Modal>
    )
  }

  if (summary)
    return (
      <Modal title="Import finished" onClose={close} footer={<button className="btn primary" onClick={close}>Done</button>}>
        <div className="import-summary">
          {summary.collections.map((c) => (
            <div key={c.name} className="summary-row ok">
              <CheckCircle2 size={15} /> Collection “{c.name}” — {c.requests} requests
            </div>
          ))}
          {summary.environments.map((e) => (
            <div key={e} className="summary-row ok">
              <CheckCircle2 size={15} /> Environment “{e}”
            </div>
          ))}
          {summary.globals > 0 && (
            <div className="summary-row ok">
              <CheckCircle2 size={15} /> {summary.globals} global variables
            </div>
          )}
          {summary.request && (
            <div className="summary-row ok">
              <CheckCircle2 size={15} /> Request “{summary.request}” opened in a new tab
            </div>
          )}
          {summary.errors.map((e) => (
            <div key={e} className="summary-row bad">
              <AlertTriangle size={15} /> {e}
            </div>
          ))}
          {summary.warnings.length > 0 && (
            <>
              <div className="summary-head">Notes ({summary.warnings.length})</div>
              <ul className="summary-warnings">
                {summary.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    )

  return (
    <Modal title="Import" onClose={close} width={620}>
      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <FileJson size={32} strokeWidth={1.4} />
        <div className="dropzone-title">Drop files here</div>
        <div className="muted small">
          Collections (v1, v2.0, v2.1), environments, globals, full data dumps, or FlosForge Caller backups
        </div>
        <button className="btn primary" onClick={chooseFiles}>
          <FolderOpen size={14} /> Choose files…
        </button>
      </div>
      <div className="or">or paste</div>
      <textarea
        className="paste-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"curl https://api.example.com/users -H 'Accept: application/json'\n\n…or paste exported collection JSON"}
        spellCheck={false}
      />
      <div className="modal-inline-footer">
        <span className="hint">Tip: you can also paste a cURL command straight into the URL bar.</span>
        <button className="btn secondary" disabled={!text.trim()} onClick={() => run([{ content: text }])}>
          Import text
        </button>
      </div>
    </Modal>
  )
}
