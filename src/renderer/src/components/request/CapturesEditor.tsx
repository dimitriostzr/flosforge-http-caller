import { useMemo, useState } from 'react'
import { Pipette, Plus, Send, Sparkles, Trash2, X } from 'lucide-react'
import { newCapture } from '@shared/model'
import type { Capture, CaptureScope, CaptureSource } from '@shared/types'
import {
  extractCapture,
  formatJsonPath,
  jsonEntries,
  nameForPath,
  suggestCaptures,
  type CaptureResponse
} from '@shared/engine/captures'
import { decodeBody } from '@shared/engine/body'
import { activeEnvironment, useWorkspace } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { sendTab } from '../../lib/runner'
import { JsonTree } from '../response/JsonTree'

const SOURCES: { id: CaptureSource; label: string; placeholder: string }[] = [
  { id: 'body', label: 'Body (JSON)', placeholder: '$.data.token (empty: the whole body)' },
  { id: 'header', label: 'Header', placeholder: 'Location' },
  { id: 'cookie', label: 'Cookie', placeholder: 'session' },
  { id: 'status', label: 'Status code', placeholder: '' }
]

const short = (v: string, n = 60): string => (v.length > n ? `${v.slice(0, n)}…` : v)
const show = (v: unknown): string => short(typeof v === 'string' ? v : JSON.stringify(v) ?? String(v))

/** What a response offers to fill captures in with: JSON paths, header and cookie names. */
function useExample(sample: CaptureResponse | undefined) {
  return useMemo(() => {
    if (!sample) return null
    let json: unknown
    let isJson = true
    try {
      json = JSON.parse(sample.body)
    } catch {
      isJson = false
    }
    const paths = isJson
      ? jsonEntries(json, 400).map((e) => ({ path: formatJsonPath(e.path), name: nameForPath(e.path), preview: show(e.value) }))
      : []
    const headers = [...new Map(sample.headers.filter(([k]) => k.toLowerCase() !== 'set-cookie').map(([k, v]) => [k, v])).entries()]
    const cookies = sample.headers
      .filter(([k]) => k.toLowerCase() === 'set-cookie')
      .map(([, v]) => v.split(';')[0])
      .map((pair) => [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1)] as [string, string])
      .filter(([k]) => k)
    return { json, isJson, paths, headers, cookies }
  }, [sample])
}

/** A request tab's captures, with the tab's last response as the example. */
export function RequestCapturesEditor({
  tabId,
  ...rest
}: {
  tabId: string
  inCollection: boolean
  captures: Capture[]
  onChange: (captures: Capture[]) => void
}) {
  const run = useRuntime((s) => s.results[tabId])
  const sending = useRuntime((s) => !!s.sending[tabId])
  const res = run?.result?.ok ? run.result.response : undefined
  const sample = useMemo<CaptureResponse | undefined>(
    () => (res ? { status: res.status, headers: res.headers, body: decodeBody(res.body, res.headers) } : undefined),
    [res]
  )
  return <CapturesEditor {...rest} listKey={tabId} sample={sample} sending={sending} onSend={() => void sendTab(tabId)} />
}

/** Values to take from the response into variables, filled in and previewed from an example response. */
export function CapturesEditor({
  listKey,
  inCollection,
  captures,
  onChange,
  sample,
  onSend,
  sending = false,
  intro = true,
  sendLabel = 'Send to get an example response'
}: {
  /** Unique per editor on screen, for the autocomplete lists. */
  listKey: string
  inCollection: boolean
  captures: Capture[]
  onChange: (captures: Capture[]) => void
  sample?: CaptureResponse
  onSend?: () => void
  sending?: boolean
  intro?: boolean
  sendLabel?: string
}) {
  const env = useWorkspace(activeEnvironment)
  const example = useExample(sample)
  const suggestions = useMemo(
    () => (sample ? suggestCaptures(sample).filter((s) => !captures.some((c) => c.variable === s.capture.variable)) : []),
    [sample, captures]
  )
  const [picking, setPicking] = useState<string | null>(null)
  const defaultScope: CaptureScope = env ? 'environment' : inCollection ? 'collection' : 'local'

  const set = (id: string, patch: Partial<Capture>) => onChange(captures.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const add = (partial: Partial<Capture> = {}) => {
    const c = newCapture({ scope: defaultScope, ...partial })
    onChange([...captures, c])
    return c
  }
  const scopes: { id: CaptureScope; label: string }[] = [
    { id: 'environment', label: env ? `Environment (${env.name})` : 'Environment (none active)' },
    { id: 'collection', label: inCollection ? 'Collection' : 'Collection (not saved in one)' },
    { id: 'globals', label: 'Globals' },
    { id: 'local', label: 'This run only' }
  ]
  const pickingRow = captures.find((c) => c.id === picking)
  const listId = (source: CaptureSource) => `cap-${listKey}-${source}`

  return (
    <div className={intro ? 'scroll-pad' : 'captures-embedded'}>
      {intro && (
        <p className="hint captures-intro">
          Take values from the response into variables, with no script: a token for the next request, an id from a list.
          Captures run when the response arrives, before the test scripts, in single sends, the runner and the command
          line.
        </p>
      )}

      {example && (
        <>
          <datalist id={listId('body')}>
            {example.paths.map((p) => (
              <option key={p.path} value={p.path} label={p.preview} />
            ))}
          </datalist>
          <datalist id={listId('header')}>
            {example.headers.map(([k, v]) => (
              <option key={k} value={k} label={short(v)} />
            ))}
          </datalist>
          <datalist id={listId('cookie')}>
            {example.cookies.map(([k, v]) => (
              <option key={k} value={k} label={short(v)} />
            ))}
          </datalist>
        </>
      )}

      {suggestions.length > 0 && (
        <div className="cap-suggest">
          <span className="cap-suggest-label">
            <Sparkles size={13} /> From the last response
          </span>
          {suggestions.map((s) => (
            <button key={s.capture.variable} className="cap-chip" onClick={() => add(s.capture)} title={`Capture ${s.capture.path || s.capture.source} into {{${s.capture.variable}}}`}>
              <Plus size={12} />
              <code>{s.capture.variable}</code>
              <span className="muted">← {s.capture.source === 'body' ? s.capture.path : `${s.capture.source} ${s.capture.path}`}</span>
              <span className="cap-chip-value">{short(s.preview, 28)}</span>
            </button>
          ))}
        </div>
      )}

      {captures.length > 0 && (
        <div className="cap-table">
          <div className="cap-row cap-head">
            <span />
            <span>Variable</span>
            <span>From</span>
            <span>Path or name</span>
            <span>Pattern (optional)</span>
            <span>Save to</span>
            <span>{sample ? 'From the last response' : 'Preview'}</span>
            <span />
          </div>
          {captures.map((c) => {
            const source = SOURCES.find((s) => s.id === c.source) ?? SOURCES[0]
            const preview = sample && c.variable.trim() ? extractCapture(c, sample) : undefined
            const canPick = !!example && c.source !== 'status'
            return (
              <div key={c.id} className={`cap-row ${c.enabled ? '' : 'disabled'} ${picking === c.id ? 'picking' : ''}`}>
                <input type="checkbox" checked={c.enabled} onChange={(e) => set(c.id, { enabled: e.target.checked })} title="Run this capture" />
                <input
                  className="cap-input mono"
                  value={c.variable}
                  placeholder="token"
                  spellCheck={false}
                  onChange={(e) => set(c.id, { variable: e.target.value.replace(/[{}]/g, '') })}
                />
                <select className="cap-input" value={c.source} onChange={(e) => set(c.id, { source: e.target.value as CaptureSource })}>
                  {SOURCES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <span className="cap-path">
                  <input
                    className="cap-input mono"
                    value={c.source === 'status' ? '' : c.path}
                    placeholder={source.placeholder}
                    disabled={c.source === 'status'}
                    spellCheck={false}
                    list={example && c.source !== 'status' ? listId(c.source) : undefined}
                    onChange={(e) => {
                      const path = e.target.value
                      // Picked from the suggestions with no name yet: name it after the key.
                      const known = c.source === 'body' ? example?.paths.find((p) => p.path === path) : undefined
                      const name = !c.variable.trim()
                        ? known?.name || (c.source !== 'body' && example && [...example.headers, ...example.cookies].some(([k]) => k === path) ? path : '')
                        : ''
                      set(c.id, { path, ...(name ? { variable: name.replace(/[^\w.-]/g, '_') } : {}) })
                    }}
                  />
                  {canPick && (
                    <button
                      className={`icon-btn subtle ${picking === c.id ? 'active' : ''}`}
                      title="Pick it from the last response"
                      onClick={() => setPicking(picking === c.id ? null : c.id)}
                    >
                      <Pipette size={13} />
                    </button>
                  )}
                </span>
                <input
                  className="cap-input mono"
                  value={c.regex}
                  placeholder="Bearer (.+)"
                  spellCheck={false}
                  title="A regular expression run on the value: its first group, or the whole match, is kept"
                  onChange={(e) => set(c.id, { regex: e.target.value })}
                />
                <select className="cap-input" value={c.scope} onChange={(e) => set(c.id, { scope: e.target.value as CaptureScope })}>
                  {scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <span className="cap-preview">
                  {!preview ? (
                    <span className="muted">—</span>
                  ) : 'error' in preview ? (
                    <span className="warn-text" title={preview.error}>
                      {preview.error}
                    </span>
                  ) : (
                    <code title={preview.value}>{preview.value === '' ? '(empty)' : preview.value}</code>
                  )}
                </span>
                <button className="icon-btn subtle" title="Remove" onClick={() => onChange(captures.filter((x) => x.id !== c.id))}>
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {pickingRow && example && (
        <div className="cap-picker">
          <div className="cap-picker-head">
            <span>
              Click the value for <code>{`{{${pickingRow.variable || '…'}}}`}</code>
              <span className="muted"> · from the last response’s {pickingRow.source === 'body' ? 'body' : `${pickingRow.source}s`}</span>
            </span>
            <button className="icon-btn subtle" title="Close" onClick={() => setPicking(null)}>
              <X size={14} />
            </button>
          </div>
          {pickingRow.source === 'body' ? (
            example.isJson ? (
              <div className="cap-picker-body">
                <JsonTree
                  data={example.json}
                  openDepth={2}
                  pickOnClick
                  onCapture={(path) => {
                    set(pickingRow.id, { path: formatJsonPath(path), ...(pickingRow.variable.trim() ? {} : { variable: nameForPath(path) }) })
                    setPicking(null)
                  }}
                />
              </div>
            ) : (
              <p className="hint pad">The last response’s body isn’t JSON. Leave the path empty to take all of it, and narrow it with a pattern.</p>
            )
          ) : (
            <div className="cap-picker-body">
              {(pickingRow.source === 'header' ? example.headers : example.cookies).map(([k, v]) => (
                <button
                  key={k}
                  className="cap-pick-row"
                  onClick={() => {
                    set(pickingRow.id, { path: k, ...(pickingRow.variable.trim() ? {} : { variable: k.replace(/[^\w.-]/g, '_') }) })
                    setPicking(null)
                  }}
                >
                  <code>{k}</code>
                  <span className="muted">{short(v, 90)}</span>
                </button>
              ))}
              {(pickingRow.source === 'header' ? example.headers : example.cookies).length === 0 && (
                <p className="hint pad">The last response had no {pickingRow.source}s.</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="row-gap" style={{ marginTop: 10 }}>
        <button className="btn secondary small" onClick={() => add()}>
          <Plus size={14} /> Add capture
        </button>
        {!sample && onSend && (
          <button className="btn ghost small" onClick={onSend} disabled={sending}>
            <Send size={13} /> {sending ? 'Sending…' : sendLabel}
          </button>
        )}
      </div>
      <p className="hint">
        {sample
          ? 'Paths autocomplete from the last response, and the eyedropper lets you click a value instead of typing it. The preview shows what each capture takes.'
          : 'With an example response, paths autocomplete, you can click a value to capture it, and each capture shows what it would take.'}{' '}
        Paths look like <code>$.data.items[0].id</code>; <code>[-1]</code> is the last item.
      </p>
    </div>
  )
}
