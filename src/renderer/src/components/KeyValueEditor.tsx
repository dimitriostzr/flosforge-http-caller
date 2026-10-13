import { useState, type ReactNode } from 'react'
import { Trash2, GripVertical } from 'lucide-react'
import { uid } from '@shared/model'
import type { KeyValue } from '@shared/types'
import { VarInput } from './editor/VarInput'

interface Props<T extends KeyValue> {
  rows: T[]
  onChange: (rows: T[]) => void
  /** Creates a new row; receives the id to use so focus survives the ghost → real row transition. */
  create: (id: string) => T
  keyPlaceholder?: string
  valuePlaceholder?: string
  keySuggestions?: string[]
  showDescription?: boolean
  /** Replaces the value cell (e.g. a file picker for form-data); return undefined for the default input. */
  renderValue?: (row: T, update: (patch: Partial<T>) => void) => ReactNode
  /** Extra cell rendered between value and description. */
  renderExtra?: (row: T, update: (patch: Partial<T>) => void) => ReactNode
  extraHeader?: ReactNode
  isMasked?: (row: T) => boolean
  bulk?: boolean
  readOnly?: boolean
}

let datalistSeq = 0

export function KeyValueEditor<T extends KeyValue>({
  rows,
  onChange,
  create,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  keySuggestions,
  showDescription = false,
  renderValue,
  renderExtra,
  extraHeader,
  isMasked,
  bulk = false,
  readOnly
}: Props<T>) {
  const [ghostId, setGhostId] = useState(uid)
  const [listId] = useState(() => `kv-suggest-${++datalistSeq}`)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const update = (id: string, patch: Partial<T>): void => {
    const existing = rows.find((r) => r.id === id)
    if (existing) onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    else {
      onChange([...rows, { ...create(id), ...patch }])
      setGhostId(uid())
    }
  }
  const remove = (id: string): void => onChange(rows.filter((r) => r.id !== id))
  const move = (from: number, to: number): void => {
    if (from === to) return
    const next = [...rows]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it)
    onChange(next)
  }

  if (bulk) return <BulkEditor rows={rows} onChange={onChange} create={create} readOnly={readOnly} />

  const ghost = create(ghostId)
  const all = readOnly ? rows : [...rows, ghost]
  const allOn = rows.length > 0 && rows.every((r) => r.enabled)

  return (
    <div className={`kv ${showDescription ? 'with-desc' : ''} ${renderExtra ? 'with-extra' : ''}`}>
      {keySuggestions && (
        <datalist id={listId}>
          {keySuggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <div className="kv-row kv-head">
        <div className="kv-cell kv-check">
          {!readOnly && (
            <input
              type="checkbox"
              checked={allOn}
              disabled={!rows.length}
              onChange={(e) => onChange(rows.map((r) => ({ ...r, enabled: e.target.checked })))}
              title="Toggle all"
            />
          )}
        </div>
        <div className="kv-cell">Key</div>
        <div className="kv-cell">Value</div>
        {renderExtra && <div className="kv-cell kv-extra">{extraHeader}</div>}
        {showDescription && <div className="kv-cell">Description</div>}
        <div className="kv-cell kv-actions" />
      </div>
      {all.map((row, i) => {
        const isGhost = row.id === ghostId && !rows.some((r) => r.id === ghostId)
        const set = (patch: Partial<T>) => update(row.id, patch)
        return (
          <div
            key={row.id}
            className={`kv-row ${isGhost ? 'ghost' : ''} ${!row.enabled && !isGhost ? 'disabled' : ''} ${dragIndex === i ? 'dragging' : ''}`}
            onDragOver={(e) => {
              if (dragIndex === null || isGhost) return
              e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex !== null && !isGhost) move(dragIndex, i)
              setDragIndex(null)
            }}
          >
            <div className="kv-cell kv-check">
              {!isGhost && !readOnly && (
                <>
                  <span
                    className="kv-grip"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragIndex(i)
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <GripVertical size={12} />
                  </span>
                  <input type="checkbox" checked={row.enabled} onChange={(e) => set({ enabled: e.target.checked } as Partial<T>)} />
                </>
              )}
            </div>
            <div className="kv-cell">
              <input
                className="kv-input"
                value={row.key}
                placeholder={keyPlaceholder}
                list={keySuggestions ? listId : undefined}
                onChange={(e) => set({ key: e.target.value } as Partial<T>)}
                readOnly={readOnly}
                spellCheck={false}
              />
            </div>
            <div className="kv-cell">
              {renderValue?.(row, set) ?? (
                <VarInput
                  value={row.value}
                  placeholder={valuePlaceholder}
                  onChange={(v) => set({ value: v } as Partial<T>)}
                  masked={isMasked?.(row)}
                  readOnly={readOnly}
                />
              )}
            </div>
            {renderExtra && <div className="kv-cell kv-extra">{!isGhost && renderExtra(row, set)}</div>}
            {showDescription && (
              <div className="kv-cell">
                <input
                  className="kv-input muted"
                  value={row.description ?? ''}
                  placeholder="Description"
                  onChange={(e) => set({ description: e.target.value } as Partial<T>)}
                  readOnly={readOnly}
                />
              </div>
            )}
            <div className="kv-cell kv-actions">
              {!isGhost && !readOnly && (
                <button className="icon-btn subtle" onClick={() => remove(row.id)} title="Remove">
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Plain-text editing: one `key: value` per line, `//` prefix disables a row. */
function BulkEditor<T extends KeyValue>({
  rows,
  onChange,
  create,
  readOnly
}: Pick<Props<T>, 'rows' | 'onChange' | 'create' | 'readOnly'>) {
  const [text, setText] = useState(() =>
    rows.map((r) => `${r.enabled ? '' : '//'}${r.key}: ${r.value}`).join('\n')
  )
  const apply = (t: string): void => {
    setText(t)
    const pool = [...rows]
    const next = t
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        let enabled = true
        let l = line
        if (l.trimStart().startsWith('//')) {
          enabled = false
          l = l.trimStart().slice(2)
        }
        const i = l.indexOf(':')
        const key = (i === -1 ? l : l.slice(0, i)).trim()
        const value = i === -1 ? '' : l.slice(i + 1).trim()
        const idx = pool.findIndex((r) => r.key === key)
        const base = idx !== -1 ? pool.splice(idx, 1)[0] : create(uid())
        return { ...base, key, value, enabled }
      })
    onChange(next)
  }
  return (
    <textarea
      className="bulk-editor"
      value={text}
      onChange={(e) => apply(e.target.value)}
      readOnly={readOnly}
      spellCheck={false}
      placeholder={'Content-Type: application/json\n//Disabled-Header: value'}
    />
  )
}

export const COMMON_HEADERS = [
  'Accept',
  'Accept-Charset',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Disposition',
  'Content-Encoding',
  'Content-Language',
  'Content-Type',
  'Cookie',
  'Date',
  'ETag',
  'Expect',
  'Forwarded',
  'From',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'If-Range',
  'If-Unmodified-Since',
  'Origin',
  'Pragma',
  'Prefer',
  'Range',
  'Referer',
  'TE',
  'Upgrade',
  'User-Agent',
  'Via',
  'X-API-Key',
  'X-Correlation-ID',
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Request-ID',
  'X-Requested-With'
]
