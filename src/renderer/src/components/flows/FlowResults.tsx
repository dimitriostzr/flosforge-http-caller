import { useMemo, useState } from 'react'
import { CheckCircle2, Clock, Loader2, MinusCircle, Play, Workflow, XCircle } from 'lucide-react'
import type { Flow } from '@shared/types'
import type { FlowStepResult } from '@shared/engine/flowRun'
import type { FlowRunState } from '../../store/runtime'
import { formatBytes, formatMs, prettyJson, statusTone } from '../../lib/format'
import { CodeEditor } from '../editor/CodeEditor'
import { Empty, MethodBadge } from '../ui'

const SCOPE_NAMES = { environment: 'environment', collection: 'collection', globals: 'globals', local: 'this run only' } as const

/** The flow's last run: a summary, one row per step, and the chosen step's details and response. */
export function FlowResults({
  flow,
  run,
  selectedId,
  onSelect,
  onRun
}: {
  flow: Flow
  run: FlowRunState | undefined
  selectedId: string | null
  onSelect: (stepId: string) => void
  onRun: () => void
}) {
  const resultFor = (id: string): { r?: FlowStepResult; stale: boolean } => {
    const fresh = run?.results[id]
    return { r: fresh ?? run?.previous[id], stale: !fresh }
  }
  // Show what was asked for; else the first failure; else the last step that ran.
  const shownId = useMemo(() => {
    if (selectedId && resultFor(selectedId).r) return selectedId
    const ran = flow.steps.filter((s) => run?.results[s.id])
    return (ran.find((s) => !run!.results[s.id].passed) ?? ran[ran.length - 1])?.id ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, run, flow.steps])

  if (!run)
    return (
      <div className="flow-results">
        <Empty icon={<Workflow size={30} strokeWidth={1.4} />} title="No results yet">
          <p>Run the flow to see each step’s status, what it captured, its tests and its response here.</p>
          <button className="btn primary small" onClick={onRun} disabled={!flow.steps.length}>
            <Play size={13} /> Run flow
          </button>
        </Empty>
      </div>
    )

  const shown = shownId ? resultFor(shownId) : undefined
  return (
    <div className="flow-results">
      <Summary flow={flow} run={run} />
      <div className="flow-res-list">
        {flow.steps.map((s, i) => {
          const { r, stale } = resultFor(s.id)
          const active = run.status === 'running' && run.progress?.index === i
          const pending = run.status === 'running' && !run.results[s.id] && !active
          const icon = active ? (
            <Loader2 size={14} className="spin" />
          ) : !r || pending ? (
            <span className="flow-res-dot" />
          ) : r.skipped ? (
            <MinusCircle size={14} />
          ) : r.passed ? (
            <CheckCircle2 size={14} />
          ) : (
            <XCircle size={14} />
          )
          const tone = active ? 'running' : !r || pending ? 'pending' : r.skipped ? 'skipped' : r.passed ? 'pass' : 'fail'
          return (
            <button
              key={s.id}
              className={`flow-res-row ${tone} ${stale && r ? 'stale' : ''} ${shownId === s.id ? 'selected' : ''}`}
              onClick={() => r && onSelect(s.id)}
              disabled={!r}
            >
              <span className="flow-res-num">{i + 1}</span>
              <span className="flow-res-icon">{icon}</span>
              {s.kind === 'delay' ? (
                <span className="flow-res-name">
                  <Clock size={12} /> Wait {s.delayMs ?? 0} ms
                </span>
              ) : (
                <span className="flow-res-name">
                  {r?.method && <MethodBadge method={r.method} short />}
                  {r?.name ?? 'Not run yet'}
                </span>
              )}
              <span className="flow-res-meta">
                {r?.skipped ? (
                  'skipped'
                ) : (
                  <>
                    {r?.status !== undefined && <b className={`tone-${statusTone(r.status)}`}>{r.status}</b>}
                    {r?.timeMs !== undefined && <span>{formatMs(r.timeMs)}</span>}
                    {r && r.attempts > 1 && <span>×{r.attempts}</span>}
                  </>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {shown?.r && <StepDetail key={shownId} index={flow.steps.findIndex((s) => s.id === shownId)} result={shown.r} stale={shown.stale} />}
    </div>
  )
}

function Summary({ flow, run }: { flow: Flow; run: FlowRunState }) {
  if (run.status === 'running') {
    const p = run.progress
    return (
      <div className="banner info">
        <Loader2 size={14} className="spin" />
        <span>
          {p ? `Running step ${p.index + 1} of ${flow.steps.length}: ${p.name}${p.attempt > 1 ? ` (try ${p.attempt})` : ''}` : 'Starting…'}
        </span>
      </div>
    )
  }
  const s = run.summary
  if (!s) return null
  const ok = s.stoppedBecause === 'completed' && s.failed === 0
  const cancelled = s.stoppedBecause === 'cancelled'
  return (
    <div className={`banner ${ok ? 'ok' : cancelled ? 'warn' : 'bad'}`}>
      {ok ? <CheckCircle2 size={14} /> : cancelled ? <MinusCircle size={14} /> : <XCircle size={14} />}
      <span>
        {cancelled
          ? `Stopped by you after ${s.steps} step${s.steps === 1 ? '' : 's'}`
          : s.stoppedBecause === 'failed'
            ? (s.note ?? 'Stopped at a failed step')
            : s.failed
              ? `Finished with ${s.failed} failed step${s.failed === 1 ? '' : 's'}`
              : `All ${s.steps} steps passed`}{' '}
        · {formatMs(s.finishedAt - s.startedAt)}
      </span>
    </div>
  )
}

function StepDetail({ index, result, stale }: { index: number; result: FlowStepResult; stale: boolean }) {
  const [tab, setTab] = useState<'body' | 'headers'>('body')
  const res = result.response
  const body = useMemo(() => {
    if (!res) return { text: '', json: false }
    try {
      JSON.parse(res.body)
      return { text: prettyJson(res.body), json: true }
    } catch {
      return { text: res.body, json: false }
    }
  }, [res])
  const lines = [
    ...result.captures.map((c) => ({
      key: `c-${c.variable}`,
      ok: !c.error,
      text: c.error ? `{{${c.variable}}}: ${c.error}` : `{{${c.variable}}} = ${c.value}`,
      note: c.error ? undefined : SCOPE_NAMES[c.scope]
    })),
    ...result.tests.map((t, i) => ({ key: `t-${i}`, ok: t.passed || !!t.skipped, text: t.error ? `${t.name}: ${t.error}` : t.name, note: t.skipped ? 'skipped' : undefined })),
    ...result.scriptErrors.map((e, i) => ({ key: `e-${i}`, ok: false, text: e, note: 'script' }))
  ]

  return (
    <div className={`flow-res-detail ${stale ? 'stale' : ''}`}>
      <div className="flow-res-head">
        <span className="flow-res-title">
          Step {index + 1} · {result.name}
        </span>
        {result.status !== undefined && (
          <span className={`status-pill tone-${statusTone(result.status)}`}>
            {result.status} {result.statusText}
          </span>
        )}
        {result.timeMs !== undefined && <span className="muted small">{formatMs(result.timeMs)}</span>}
        {result.sizeBytes !== undefined && <span className="muted small">{formatBytes(result.sizeBytes)}</span>}
        {result.attempts > 1 && <span className="muted small">{result.attempts} tries</span>}
        {stale && <span className="muted small">· from the previous run</span>}
      </div>
      {result.url && (
        <div className="mono small flow-res-url">
          {result.method} {result.url}
        </div>
      )}
      {result.skipped && <p className="hint">{result.skipped}</p>}
      {result.error && <div className="test-error">{result.error}</div>}
      {lines.length > 0 && (
        <div className="flow-res-lines">
          {lines.map((l) => (
            <div key={l.key} className={`flow-line ${l.ok ? 'ok' : 'bad'}`}>
              {l.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} <span>{l.text}</span>
              {l.note && <em className="muted small">{l.note}</em>}
            </div>
          ))}
        </div>
      )}
      {res && (
        <div className="flow-res-response">
          <div className="seg small">
            <button className={tab === 'body' ? 'active' : ''} onClick={() => setTab('body')}>
              Body
            </button>
            <button className={tab === 'headers' ? 'active' : ''} onClick={() => setTab('headers')}>
              Headers ({res.headers.length})
            </button>
          </div>
          <div className="flow-res-body">
            {tab === 'body' ? (
              res.body ? (
                <CodeEditor value={body.text} readOnly language={body.json ? 'json' : 'text'} lineNumbers={body.json} lineWrapping />
              ) : (
                <p className="hint pad">Empty body.</p>
              )
            ) : (
              <div className="scroll-pad tight">
                <table className="data-table compact">
                  <tbody>
                    {res.headers.map(([k, v], i) => (
                      <tr key={i}>
                        <td className="data-key">{k}</td>
                        <td className="data-value">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
