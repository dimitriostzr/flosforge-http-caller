import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, FileDown, FileText, Loader2, SendHorizontal, XCircle, MinusCircle } from 'lucide-react'
import type { HttpResponse } from '@shared/types'
import { useRuntime, type RunResult } from '../../store/runtime'
import { useWorkspace } from '../../store/workspace'
import { toast } from '../../store/dialogs'
import { cancelTab } from '../../lib/runner'
import {
  decodeBody,
  detectKind,
  extensionFor,
  formatBytes,
  formatMs,
  getHeader,
  looksBinary,
  prettyJson,
  prettyXml,
  statusTone,
  type BodyKind
} from '../../lib/format'
import { CodeEditor, type EditorLanguage } from '../editor/CodeEditor'
import { REPORT_FORMATS } from '@shared/engine/exports'
import { exportResult } from '../../lib/exports'
import { openMenu } from '../ui'
import { JsonTree } from './JsonTree'
import { JsonTable } from './JsonTable'
import { Empty, Tabs, modKey } from '../ui'

type RTab = 'body' | 'headers' | 'cookies' | 'tests' | 'logs' | 'timeline'
const tabMemory = new Map<string, RTab>()

export function ResponseView({ tabId }: { tabId: string }) {
  const run = useRuntime((s) => s.results[tabId])
  const sending = useRuntime((s) => !!s.sending[tabId])
  const [tab, setTabState] = useState<RTab>(() => tabMemory.get(tabId) ?? 'body')
  const setTab = (t: RTab) => {
    tabMemory.set(tabId, t)
    setTabState(t)
  }

  if (sending)
    return (
      <div className="response-view">
        <SendingState onCancel={() => cancelTab(tabId)} />
      </div>
    )

  if (!run)
    return (
      <div className="response-view">
        <Empty icon={<SendHorizontal size={34} strokeWidth={1.4} />} title="No response yet">
          Hit <kbd>Send</kbd> or press <kbd>{modKey}</kbd>+<kbd>Enter</kbd> to fire the request.
        </Empty>
      </div>
    )

  const res = run.result?.ok ? run.result.response : undefined
  const failure = run.error ?? (run.result && !run.result.ok ? run.result.error.message : undefined)
  const failureCode = run.result && !run.result.ok ? run.result.error.code : undefined
  const passed = run.tests.filter((t) => t.passed && !t.skipped).length
  const testable = run.tests.filter((t) => !t.skipped).length
  const cookieCount = res ? res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').length : 0

  return (
    <div className="response-view">
      {res && <StatusLine res={res} tabId={tabId} />}
      {run.scriptErrors.length > 0 && (
        <div className="banner warn">
          <AlertTriangle size={14} />
          <span>Script error — {run.scriptErrors[0]}</span>
          <button className="link" onClick={() => setTab('logs')}>
            View logs
          </button>
        </div>
      )}
      {failure && !res ? (
        <>
          <div className="response-error">
            <XCircle size={30} strokeWidth={1.5} />
            <div className="response-error-title">{failureCode === 'ECANCELLED' ? 'Request cancelled' : run.error ? 'Request not sent' : 'Could not get a response'}</div>
            <div className="response-error-msg">{failure}</div>
            {failureCode && <div className="response-error-code">{failureCode}</div>}
          </div>
          {run.logs.length > 0 && <LogsView run={run} />}
        </>
      ) : res ? (
        <>
          <Tabs<RTab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'body', label: 'Body' },
              { id: 'headers', label: 'Headers', badge: res.headers.length },
              { id: 'cookies', label: 'Cookies', badge: cookieCount || undefined },
              {
                id: 'tests',
                label: 'Tests',
                badge: testable ? (
                  <span className={passed === testable ? 'ok' : 'bad'}>
                    {passed}/{testable}
                  </span>
                ) : undefined
              },
              { id: 'logs', label: 'Logs', badge: run.logs.length || undefined },
              { id: 'timeline', label: 'Timeline' }
            ]}
          />
          <div className="response-content">
            {tab === 'body' && <BodyView key={run.at} res={res} />}
            {tab === 'headers' && <HeadersTable headers={res.headers} />}
            {tab === 'cookies' && <CookiesTable res={res} />}
            {tab === 'tests' && <TestsView run={run} />}
            {tab === 'logs' && <LogsView run={run} />}
            {tab === 'timeline' && <TimelineView run={run} res={res} />}
          </div>
        </>
      ) : null}
    </div>
  )
}

function SendingState({ onCancel }: { onCancel: () => void }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => setElapsed(Date.now() - start), 100)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="sending">
      <Loader2 className="spin" size={26} />
      <div>Waiting for response… {elapsed > 300 && <span className="muted">{(elapsed / 1000).toFixed(1)}s</span>}</div>
      <button className="btn ghost small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

function StatusLine({ res, tabId }: { res: HttpResponse; tabId: string }) {
  const tone = statusTone(res.status)
  const t = res.timings
  return (
    <div className="status-line">
      <span className={`status-pill tone-${tone}`}>
        {res.status} {res.statusText}
      </span>
      <span className="stat timing-host">
        <span className="stat-label">Time</span> {formatMs(t.total)}
        <div className="timing-pop">
          <TimingBars res={res} />
        </div>
      </span>
      <span className="stat" title={`Headers ${formatBytes(res.headersSize)} · Body ${formatBytes(res.bodySize)} on the wire`}>
        <span className="stat-label">Size</span> {formatBytes(res.bodySize + res.headersSize)}
      </span>
      {res.redirects.length > 0 && (
        <span className="stat">
          <span className="stat-label">Redirects</span> {res.redirects.length}
        </span>
      )}
      <div className="spacer" />
      <button
        className="icon-btn"
        title="Copy body"
        onClick={() => {
          void navigator.clipboard.writeText(decodeBody(res.body, res.headers))
          toast('Response body copied')
        }}
      >
        <Copy size={14} />
      </button>
      <button
        className="btn ghost small"
        title="Save the body, or the whole result as a report"
        onClick={(e) =>
          openMenu(e, [
            {
              label: 'Save body as file…',
              icon: <FileDown size={14} />,
              onClick: () => {
                const ext = extensionFor(getHeader(res.headers, 'content-type'))
                const name = (res.url.split('?')[0].split('/').pop() || 'response').replace(/\.[a-z0-9]+$/i, '')
                void window.api.saveFile(`${name}.${ext}`, res.body)
              }
            },
            { separator: true },
            ...REPORT_FORMATS.map((f) => ({
              label: `Report as ${f.label}`,
              icon: <FileText size={14} />,
              onClick: () => void exportResult(tabId, f.id)
            }))
          ])
        }
      >
        <Download size={14} /> Export
      </button>
    </div>
  )
}

function TimingBars({ res }: { res: HttpResponse }) {
  const t = res.timings
  const rows: [string, number | undefined][] = [
    ['DNS lookup', t.dns],
    ['TCP connect', t.connect],
    ['TLS handshake', t.tls],
    ['Waiting (TTFB)', t.firstByte],
    ['Download', t.download]
  ]
  const max = Math.max(1, t.total)
  let offset = 0
  return (
    <div className="timing-bars">
      {rows.map(([label, v]) => {
        const left = offset
        if (v !== undefined) offset += v
        return (
          <div key={label} className="timing-row">
            <span className="timing-label">{label}</span>
            <span className="timing-track">
              {v !== undefined && (
                <span className="timing-bar" style={{ left: `${(left / max) * 100}%`, width: `${Math.max(0.5, (v / max) * 100)}%` }} />
              )}
            </span>
            <span className="timing-val">{v === undefined ? '—' : formatMs(v)}</span>
          </div>
        )
      })}
      <div className="timing-row total">
        <span className="timing-label">Total</span>
        <span className="timing-track" />
        <span className="timing-val">{formatMs(t.total)}</span>
      </div>
    </div>
  )
}

type BodyMode = 'pretty' | 'raw' | 'tree' | 'table' | 'preview'

/** The last view picked for a JSON body, reused for the next JSON response. */
let lastJsonMode: BodyMode = 'pretty'

const MODE_HINT: Record<BodyMode, string> = {
  pretty: 'Formatted, highlighted and foldable',
  raw: 'Exactly as received',
  tree: 'Click to expand; hover a row to copy its value or path',
  table: 'Arrays as rows; click a nested value to open it',
  preview: 'Rendered'
}

const LANG_FOR: Partial<Record<BodyKind, EditorLanguage>> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  javascript: 'javascript'
}

function BodyView({ res }: { res: HttpResponse }) {
  const contentType = getHeader(res.headers, 'content-type')
  const binary = useMemo(() => looksBinary(res.body), [res.body])
  const text = useMemo(() => (binary ? null : decodeBody(res.body, res.headers)), [res, binary])
  const kind = useMemo(() => detectKind(contentType, text), [contentType, text])
  const canPreview = kind === 'html' || kind === 'image'
  const canPretty = kind === 'json' || kind === 'xml' || kind === 'html'
  const parsed = useMemo(() => {
    if (kind !== 'json' || text === null) return undefined
    try {
      return { value: JSON.parse(text) as unknown }
    } catch {
      return undefined
    }
  }, [kind, text])
  const [mode, setModeState] = useState<BodyMode>(
    kind === 'image' ? 'preview' : parsed ? lastJsonMode : canPretty ? 'pretty' : 'raw'
  )
  const setMode = (m: BodyMode) => {
    if (parsed) lastJsonMode = m
    setModeState(m)
  }
  const [wrap, setWrap] = useState(true)
  const [treeDepth, setTreeDepth] = useState({ depth: 2, version: 0 })

  const shown = useMemo(() => {
    if (text === null) return ''
    if (mode !== 'pretty' || text.length > 15_000_000) return text
    if (kind === 'json') return prettyJson(text)
    if (kind === 'xml' || kind === 'html') return prettyXml(text)
    return text
  }, [text, mode, kind])

  const blobUrl = useMemo(() => {
    if (kind !== 'image') return null
    return URL.createObjectURL(new Blob([res.body as BlobPart], { type: contentType }))
  }, [res.body, kind, contentType])
  useEffect(() => () => void (blobUrl && URL.revokeObjectURL(blobUrl)), [blobUrl])

  if (res.body.length === 0)
    return <Empty title="Empty body">The server responded without a body{contentType ? ` (${contentType})` : ''}.</Empty>

  return (
    <div className="body-view">
      <div className="body-toolbar">
        <div className="seg">
          {canPretty && (
            <button className={mode === 'pretty' ? 'active' : ''} onClick={() => setMode('pretty')}>
              Pretty
            </button>
          )}
          {text !== null && (
            <button className={mode === 'raw' ? 'active' : ''} onClick={() => setMode('raw')}>
              Raw
            </button>
          )}
          {parsed && (
            <>
              <button className={mode === 'tree' ? 'active' : ''} onClick={() => setMode('tree')}>
                Tree
              </button>
              <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>
                Table
              </button>
            </>
          )}
          {canPreview && (
            <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
              Preview
            </button>
          )}
        </div>
        <span className="muted small" title={contentType}>
          {MODE_HINT[mode]} · {contentType?.split(';')[0] ?? 'no content-type'}
        </span>
        <div className="spacer" />
        {mode === 'tree' && (
          <>
            <button className="btn ghost small" onClick={() => setTreeDepth((t) => ({ depth: 64, version: t.version + 1 }))}>
              Expand all
            </button>
            <button className="btn ghost small" onClick={() => setTreeDepth((t) => ({ depth: 1, version: t.version + 1 }))}>
              Collapse
            </button>
          </>
        )}
        {text !== null && (mode === 'pretty' || mode === 'raw') && (
          <label className="check-label small">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
          </label>
        )}
      </div>
      <div className="body-view-content">
        {mode === 'preview' && kind === 'html' && text !== null && (
          // Fully sandboxed: no scripts, no same-origin, inherits the app CSP so nothing loads remotely.
          <iframe className="html-preview" sandbox="" srcDoc={text} title="HTML preview" />
        )}
        {mode === 'preview' && kind === 'image' && blobUrl && (
          <div className="image-preview">
            <img src={blobUrl} alt="Response" />
          </div>
        )}
        {(mode === 'pretty' || mode === 'raw') && text !== null && (
          <CodeEditor
            value={shown}
            readOnly
            // Raw is plain text on purpose: no highlighting, no folding, nothing reformatted.
            language={mode === 'pretty' ? (LANG_FOR[kind] ?? 'text') : 'text'}
            lineNumbers={mode === 'pretty'}
            lineWrapping={wrap}
          />
        )}
        {mode === 'tree' && parsed && (
          <div className="scroll-pad tight">
            <JsonTree key={treeDepth.version} data={parsed.value} openDepth={treeDepth.depth} />
          </div>
        )}
        {mode === 'table' && parsed && <JsonTable data={parsed.value} fileBase={(res.url.split('?')[0].split('/').pop() || 'response')} />}
        {text === null && mode !== 'preview' && (
          <Empty title="Binary response">
            {formatBytes(res.body.length)} of binary data. Use the download button to save it.
          </Empty>
        )}
      </div>
    </div>
  )
}

function HeadersTable({ headers }: { headers: [string, string][] }) {
  return (
    <div className="scroll-pad">
      <table className="data-table">
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={i}>
              <td className="data-key">{k}</td>
              <td className="data-value">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CookiesTable({ res }: { res: HttpResponse }) {
  const cookies = res.headers
    .filter(([k]) => k.toLowerCase() === 'set-cookie')
    .map(([, v]) => {
      const [pair, ...attrs] = v.split(';')
      const i = pair.indexOf('=')
      return {
        name: pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        attrs: attrs.map((a) => a.trim()).filter(Boolean)
      }
    })
  const useJar = useWorkspace((s) => s.settings.useCookieJar)
  if (!cookies.length) return <Empty title="No cookies">This response didn’t set any cookies.</Empty>
  return (
    <div className="scroll-pad">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Attributes</th>
          </tr>
        </thead>
        <tbody>
          {cookies.map((c, i) => (
            <tr key={i}>
              <td className="data-key">{c.name}</td>
              <td className="data-value">{c.value}</td>
              <td className="muted">{c.attrs.join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint pad">
        {useJar ? 'Stored in the cookie jar and sent automatically on matching requests.' : 'Cookie jar is off (Settings).'}
      </p>
    </div>
  )
}

function TestsView({ run }: { run: RunResult }) {
  if (!run.tests.length)
    return (
      <Empty title="No tests">
        Add checks in the request’s <b>Scripts → After response</b> tab, e.g.
        <code className="block">pm.test('ok', () =&gt; pm.response.to.have.status(200))</code>
      </Empty>
    )
  return (
    <div className="scroll-pad tests-list">
      {run.tests.map((t, i) => (
        <div key={i} className={`test-row ${t.skipped ? 'skipped' : t.passed ? 'pass' : 'fail'}`}>
          {t.skipped ? <MinusCircle size={15} /> : t.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          <div>
            <div className="test-name">{t.name}</div>
            {t.error && <div className="test-error">{t.error}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function LogsView({ run }: { run: RunResult }) {
  if (!run.logs.length) return <Empty title="No logs">console.log output from scripts appears here.</Empty>
  return (
    <div className="scroll-pad logs">
      {run.logs.map((l, i) => (
        <div key={i} className={`log-row log-${l.level}`}>
          <span className="log-source">{l.source}</span>
          <pre className="log-msg">{l.message}</pre>
        </div>
      ))}
    </div>
  )
}

function TimelineView({ run, res }: { run: RunResult; res: HttpResponse }) {
  const p = run.prepared
  const bodyPreview =
    p?.body.type === 'text'
      ? p.body.text
      : p?.body.type === 'multipart'
        ? p.body.fields.map((f) => `${f.name}: ${f.filePath ? `@${f.filePath}` : f.value}`).join('\n')
        : p?.body.type === 'file'
          ? `@${p.body.path}`
          : ''
  return (
    <div className="scroll-pad timeline">
      <section>
        <h4>Timing</h4>
        <TimingBars res={res} />
      </section>
      {res.redirects.length > 0 && (
        <section>
          <h4>Redirects</h4>
          {res.redirects.map((r, i) => (
            <div key={i} className="mono small">
              {r.status} → {r.url}
            </div>
          ))}
        </section>
      )}
      <section>
        <h4>Request</h4>
        <div className="mono small">
          {p?.method} {res.url}
        </div>
        {res.remoteAddress && <div className="muted small">Remote address: {res.remoteAddress}</div>}
        <table className="data-table compact">
          <tbody>
            {res.requestHeaders.map(([k, v], i) => (
              <tr key={i}>
                <td className="data-key">{k}</td>
                <td className="data-value">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bodyPreview && <pre className="request-body-preview">{bodyPreview.slice(0, 20000)}</pre>}
      </section>
      <section>
        <h4>Response</h4>
        <div className="mono small">
          HTTP/{res.httpVersion} {res.status} {res.statusText}
        </div>
      </section>
    </div>
  )
}
