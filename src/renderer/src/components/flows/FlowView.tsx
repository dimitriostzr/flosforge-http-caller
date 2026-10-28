import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  MinusCircle,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Workflow,
  XCircle
} from 'lucide-react'
import { kv, uid } from '@shared/model'
import { flattenRequests } from '@shared/tree'
import type { Flow, FlowCondition, FlowStep } from '@shared/types'
import { CONDITION_OPS, describeCondition, stepRequest, type FlowStepResult } from '@shared/engine/flowRun'
import { useWorkspace, type FlowTab } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { runFlowById, stopFlow } from '../../lib/flowRunner'
import { formatMs } from '../../lib/format'
import { useScopes } from '../../lib/useScopes'
import { VarScopesContext } from '../editor/variables'
import { VarInput } from '../editor/VarInput'
import { KeyValueEditor } from '../KeyValueEditor'
import { CapturesEditor } from '../request/CapturesEditor'
import { Empty, InlineEdit, MethodBadge } from '../ui'

const DEFAULT_RUN_IF: FlowCondition = { source: 'variable', path: '', op: 'exists', value: '' }
const DEFAULT_EXPECT: FlowCondition = { source: 'status', path: '', op: 'matches', value: '^2' }
const DEFAULT_UNTIL = { condition: { source: 'body', path: '$.status', op: 'equals', value: 'done' } as FlowCondition, times: 10, delayMs: 1000 }

export function FlowView({ tab }: { tab: FlowTab }) {
  const flow = useWorkspace((s) => s.flows.find((f) => f.id === tab.flowId))
  const update = useWorkspace((s) => s.updateFlow)
  const run = useRuntime((s) => s.flowRuns[tab.flowId])
  const scopesRef = useScopes(null)
  const [editingName, setEditingName] = useState(false)
  const [keepVariables, setKeepVariables] = useState(true)
  const [picking, setPicking] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!flow) return <Empty title="Not found">This flow was deleted.</Empty>

  const edit = (recipe: (f: Flow) => void) => update(flow.id, recipe)
  const editStep = (id: string, recipe: (s: FlowStep) => void) =>
    edit((f) => {
      const st = f.steps.find((x) => x.id === id)
      if (st) recipe(st)
    })
  const running = run?.status === 'running'
  const addStep = (step: FlowStep) => {
    edit((f) => void f.steps.push(step))
    setOpen((o) => ({ ...o, [step.id]: true }))
  }

  return (
    <VarScopesContext.Provider value={scopesRef}>
      <div className="settings-view flow-view">
        <div className="settings-header">
          <Workflow size={18} />
          {editingName ? (
            <InlineEdit
              className="title-edit"
              value={flow.name}
              onCommit={(n) => {
                edit((f) => void (f.name = n))
                setEditingName(false)
              }}
              onCancel={() => setEditingName(false)}
            />
          ) : (
            <h2 onDoubleClick={() => setEditingName(true)} title="Double-click to rename">
              {flow.name}
            </h2>
          )}
          <span className="muted small">
            {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}
          </span>
          <div className="spacer" />
          <label className="check-label small" title="Save what the flow sets in the environment, collections and globals">
            <input type="checkbox" checked={keepVariables} onChange={(e) => setKeepVariables(e.target.checked)} /> Keep variable changes
          </label>
          {running ? (
            <button className="btn danger small" onClick={() => stopFlow(flow.id)} disabled={run?.cancelRequested}>
              <Square size={12} /> {run?.cancelRequested ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button className="btn primary small" onClick={() => void runFlowById(flow.id, keepVariables)} disabled={!flow.steps.length}>
              <Play size={13} /> Run flow
            </button>
          )}
        </div>
        {run && <RunBanner flow={flow} run={run} />}

        <div className="flow-body">
          {flow.steps.length === 0 && !picking && (
            <Empty icon={<Workflow size={30} strokeWidth={1.4} />} title="An empty flow">
              <p>
                A flow runs requests from your library in order, passing what each one captures to the next: log in, create
                an order, poll until it’s paid, check the receipt. Steps can be conditional, repeat until something holds,
                and add their own checks.
              </p>
              <button className="btn primary small" onClick={() => setPicking(true)}>
                <Plus size={14} /> Add the first request
              </button>
            </Empty>
          )}
          <ol className="flow-steps">
            {flow.steps.map((step, i) => {
              const fresh = run?.results[step.id]
              const result = fresh ?? run?.previous[step.id]
              return (
                <StepCard
                  key={step.id}
                  step={step}
                  index={i}
                  count={flow.steps.length}
                  result={result}
                  stale={!fresh && !!result}
                  active={running && run?.progress?.index === i}
                  attempt={run?.progress?.index === i ? run.progress.attempt : 1}
                  open={!!open[step.id]}
                  onToggle={() => setOpen((o) => ({ ...o, [step.id]: !o[step.id] }))}
                  onChange={(recipe) => editStep(step.id, recipe)}
                  onMove={(d) =>
                    edit((f) => {
                      const [it] = f.steps.splice(i, 1)
                      f.steps.splice(Math.max(0, Math.min(f.steps.length, i + d)), 0, it)
                    })
                  }
                  onDuplicate={() =>
                    edit((f) => void f.steps.splice(i + 1, 0, { ...structuredClone(step), id: uid() }))
                  }
                  onRemove={() => edit((f) => void f.steps.splice(i, 1))}
                />
              )
            })}
          </ol>
          {picking ? (
            <RequestPicker
              onPick={(collectionId, requestId) => {
                addStep({ id: uid(), kind: 'request', enabled: true, collectionId, requestId })
                setPicking(false)
              }}
              onClose={() => setPicking(false)}
            />
          ) : (
            flow.steps.length > 0 && (
              <div className="row-gap flow-add">
                <button className="btn secondary small" onClick={() => setPicking(true)}>
                  <Plus size={14} /> Add request
                </button>
                <button className="btn ghost small" onClick={() => addStep({ id: uid(), kind: 'delay', enabled: true, delayMs: 1000 })}>
                  <Clock size={13} /> Add wait
                </button>
              </div>
            )
          )}
          {flow.steps.length > 0 && (
            <p className="hint flow-hint">
              Steps run their library request as saved, so editing a request changes every flow that uses it. What a step
              captures is there for the steps after it; “this run only” values last until the flow ends.
            </p>
          )}
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}

function RunBanner({ flow, run }: { flow: Flow; run: NonNullable<ReturnType<typeof useRuntime.getState>['flowRuns'][string]> }) {
  if (run.status === 'running') {
    const p = run.progress
    return (
      <div className="banner info flow-banner">
        <Loader2 size={14} className="spin" />
        <span>
          {p ? `Step ${p.index + 1} of ${flow.steps.length}: ${p.name}${p.attempt > 1 ? ` (try ${p.attempt})` : ''}` : 'Starting…'}
        </span>
      </div>
    )
  }
  const s = run.summary
  if (!s) return null
  const ok = s.stoppedBecause === 'completed' && s.failed === 0
  const time = formatMs(s.finishedAt - s.startedAt)
  return (
    <div className={`banner ${ok ? 'ok' : s.stoppedBecause === 'cancelled' ? 'warn' : 'bad'} flow-banner`}>
      {ok ? <CheckCircle2 size={14} /> : s.stoppedBecause === 'cancelled' ? <MinusCircle size={14} /> : <XCircle size={14} />}
      <span>
        {s.stoppedBecause === 'cancelled'
          ? `Stopped by you after ${s.steps} step${s.steps === 1 ? '' : 's'}`
          : s.stoppedBecause === 'failed'
            ? s.note ?? 'Stopped at a failed step'
            : s.failed
              ? `Finished with ${s.failed} failed step${s.failed === 1 ? '' : 's'}`
              : `All ${s.steps} steps passed`}{' '}
        · {time}
      </span>
    </div>
  )
}

function ResultBadge({ result, stale, active, attempt }: { result?: FlowStepResult; stale: boolean; active: boolean; attempt: number }) {
  if (active)
    return (
      <span className="flow-result running">
        <Loader2 size={13} className="spin" /> {attempt > 1 ? `try ${attempt}` : 'running'}
      </span>
    )
  if (!result) return null
  const cls = `flow-result ${stale ? 'stale' : ''} ${result.skipped ? 'skipped' : result.passed ? 'pass' : 'fail'}`
  if (result.skipped)
    return (
      <span className={cls} title={result.skipped}>
        <MinusCircle size={13} /> skipped
      </span>
    )
  return (
    <span className={cls} title={result.error ?? (stale ? 'From the previous run' : undefined)}>
      {result.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {result.status !== undefined && <b>{result.status}</b>}
      {result.timeMs !== undefined && <span>{formatMs(result.timeMs)}</span>}
      {result.attempts > 1 && <span>×{result.attempts}</span>}
      {result.status === undefined && !result.passed && <span>failed</span>}
    </span>
  )
}

function StepCard({
  step,
  index,
  count,
  result,
  stale,
  active,
  attempt,
  open,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove
}: {
  step: FlowStep
  index: number
  count: number
  result?: FlowStepResult
  stale: boolean
  active: boolean
  attempt: number
  open: boolean
  onToggle: () => void
  onChange: (recipe: (s: FlowStep) => void) => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const collections = useWorkspace((s) => s.collections)
  const openRequest = useWorkspace((s) => s.openRequest)
  const target = step.kind === 'request' ? stepRequest(step, collections) : null
  const chips: string[] = []
  if (step.runIf) chips.push(`if ${describeCondition(step.runIf)}`)
  if (step.repeatUntil) chips.push(`until ${describeCondition(step.repeatUntil.condition)} (max ${step.repeatUntil.times})`)
  if (step.expect) chips.push(`check ${describeCondition(step.expect)}`)
  const caps = (step.captures ?? []).filter((c) => c.enabled && c.variable.trim()).length
  if (caps) chips.push(`${caps} capture${caps === 1 ? '' : 's'}`)
  const vals = (step.variables ?? []).filter((v) => v.enabled && v.key.trim()).length
  if (vals) chips.push(`${vals} value${vals === 1 ? '' : 's'}`)
  if (step.onFailure === 'continue') chips.push('carries on if it fails')

  return (
    <li className={`flow-step ${step.enabled ? '' : 'disabled'} ${active ? 'active' : ''} ${result && !stale ? (result.skipped ? '' : result.passed ? 'passed' : 'failed') : ''}`}>
      <div className="flow-step-head" onClick={step.kind === 'request' ? onToggle : undefined}>
        <span className="flow-num">{index + 1}</span>
        <input
          type="checkbox"
          checked={step.enabled}
          title="Run this step"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange((s) => void (s.enabled = e.target.checked))}
        />
        {step.kind === 'delay' ? (
          <span className="flow-step-title" onClick={(e) => e.stopPropagation()}>
            <Clock size={14} className="muted" /> Wait
            <input
              className="text-input num small"
              type="number"
              min={0}
              step={100}
              value={step.delayMs ?? 0}
              onChange={(e) => onChange((s) => void (s.delayMs = Math.max(0, Number(e.target.value) || 0)))}
            />
            ms
          </span>
        ) : (
          <span className="flow-step-title">
            <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
            {target ? (
              <>
                <MethodBadge method={target.request.method} />
                <span className="flow-step-name">{target.request.name}</span>
                <span className="muted small flow-step-path">
                  {[target.collection.name, ...target.parents.map((p) => p.name)].join(' › ')}
                </span>
              </>
            ) : (
              <span className="warn-text">The request for this step was deleted</span>
            )}
          </span>
        )}
        <span className="flow-chips">
          {chips.map((c) => (
            <span key={c} className="flow-chip">
              {c}
            </span>
          ))}
        </span>
        <ResultBadge result={result} stale={stale} active={active} attempt={attempt} />
        <span className="flow-step-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn subtle" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </button>
          <button className="icon-btn subtle" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </button>
          <button className="icon-btn subtle" title="Duplicate" onClick={onDuplicate}>
            <Copy size={13} />
          </button>
          <button className="icon-btn subtle" title="Remove" onClick={onRemove}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>

      {!open && result && !stale && !result.passed && (result.error || result.tests.some((t) => !t.passed && !t.skipped)) && (
        <div className="flow-step-error">
          {result.error ?? `Failed: ${result.tests.filter((t) => !t.passed && !t.skipped).map((t) => t.name).join(', ')}`}
        </div>
      )}
      {step.kind === 'request' && open && (
        <div className="flow-step-body">
          {result && !result.skipped && <ResultDetail result={result} stale={stale} />}
          {result?.skipped && <p className="hint">{result.skipped}</p>}

          <section>
            <h4 className="kv-section-title">Values for this step</h4>
            <KeyValueEditor
              rows={step.variables ?? []}
              onChange={(rows) => onChange((s) => void (s.variables = rows))}
              create={(id) => ({ ...kv(), id })}
              keyPlaceholder="variable"
              valuePlaceholder="value ({{variables}} allowed)"
            />
            <p className="hint">Used by this step only, over the environment’s values. Handy for running one request twice with different input.</p>
          </section>

          <section>
            <h4 className="kv-section-title">Captures for this step</h4>
            <CapturesEditor
              listKey={step.id}
              inCollection
              intro={false}
              captures={step.captures ?? []}
              onChange={(list) => onChange((s) => void (list.length ? (s.captures = list) : delete s.captures))}
              sample={result?.response}
            />
            {target?.request.captures?.some((c) => c.enabled) && (
              <p className="hint">
                The request’s own captures run too ({target.request.captures.filter((c) => c.enabled).map((c) => `{{${c.variable}}}`).join(', ')}).
              </p>
            )}
          </section>

          <section className="flow-conditions">
            <h4 className="kv-section-title">When and how often</h4>
            <OptionalCondition
              label="Only run if"
              hint="Checked before the step, on variables. When it doesn’t hold, the step is skipped."
              value={step.runIf}
              variablesOnly
              onChange={(c) => onChange((s) => void (c ? (s.runIf = c) : delete s.runIf))}
              fallback={DEFAULT_RUN_IF}
            />
            <OptionalCondition
              label="Repeat until"
              hint="Sends again until this holds on the response, for polling a job or waiting for a status."
              value={step.repeatUntil?.condition}
              onChange={(c) =>
                onChange((s) => void (c ? (s.repeatUntil = { ...DEFAULT_UNTIL, ...s.repeatUntil, condition: c }) : delete s.repeatUntil))
              }
              fallback={DEFAULT_UNTIL.condition}
              extra={
                step.repeatUntil && (
                  <span className="flow-repeat">
                    at most
                    <input
                      className="text-input num small"
                      type="number"
                      min={1}
                      value={step.repeatUntil.times}
                      onChange={(e) => onChange((s) => void (s.repeatUntil!.times = Math.max(1, Number(e.target.value) || 1)))}
                    />
                    times, waiting
                    <input
                      className="text-input num small"
                      type="number"
                      min={0}
                      step={100}
                      value={step.repeatUntil.delayMs}
                      onChange={(e) => onChange((s) => void (s.repeatUntil!.delayMs = Math.max(0, Number(e.target.value) || 0)))}
                    />
                    ms between tries
                  </span>
                )
              }
            />
            <OptionalCondition
              label="Check that"
              hint="The step fails unless this holds, on top of failing on errors and failed tests."
              value={step.expect}
              onChange={(c) => onChange((s) => void (c ? (s.expect = c) : delete s.expect))}
              fallback={DEFAULT_EXPECT}
            />
            <div className="flow-cond-row">
              <span className="flow-cond-label">If it fails</span>
              <div className="seg">
                <button className={step.onFailure !== 'continue' ? 'active' : ''} onClick={() => onChange((s) => void delete s.onFailure)}>
                  Stop the flow
                </button>
                <button className={step.onFailure === 'continue' ? 'active' : ''} onClick={() => onChange((s) => void (s.onFailure = 'continue'))}>
                  Carry on
                </button>
              </div>
            </div>
          </section>

          {target && (
            <button className="btn ghost small" onClick={() => openRequest(target.collection.id, target.request.id)}>
              <ExternalLink size={13} /> Open the request
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function ResultDetail({ result, stale }: { result: FlowStepResult; stale: boolean }) {
  const [showBody, setShowBody] = useState(false)
  const body = useMemo(() => {
    const text = result.response?.body ?? ''
    try {
      return JSON.stringify(JSON.parse(text), null, 2).slice(0, 20000)
    } catch {
      return text.slice(0, 20000)
    }
  }, [result.response])
  return (
    <div className={`flow-detail ${stale ? 'stale' : ''}`}>
      {stale && <p className="hint">From the previous run.</p>}
      <div className="mono small flow-detail-url">
        {result.method} {result.url}
        {result.status !== undefined && (
          <span className="muted">
            {' '}
            → {result.status} {result.statusText} · {formatMs(result.timeMs ?? 0)}
          </span>
        )}
      </div>
      {result.error && <div className="test-error">{result.error}</div>}
      {[...result.captures.map((c) => ({ key: `c${c.variable}`, ok: !c.error, text: c.error ? `{{${c.variable}}}: ${c.error}` : `{{${c.variable}}} = ${c.value}` })),
        ...result.tests.map((t, i) => ({ key: `t${i}`, ok: t.passed || !!t.skipped, text: t.error ? `${t.name}: ${t.error}` : t.name })),
        ...result.scriptErrors.map((e, i) => ({ key: `e${i}`, ok: false, text: e }))].map((r) => (
        <div key={r.key} className={`flow-line ${r.ok ? 'ok' : 'bad'}`}>
          {r.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} <span>{r.text}</span>
        </div>
      ))}
      {result.response && (
        <>
          <button className="link small" onClick={() => setShowBody(!showBody)}>
            {showBody ? 'Hide the response' : 'Show the response'}
          </button>
          {showBody && <pre className="flow-body-preview">{body}</pre>}
        </>
      )}
    </div>
  )
}

function OptionalCondition({
  label,
  hint,
  value,
  onChange,
  fallback,
  variablesOnly,
  extra
}: {
  label: string
  hint: string
  value: FlowCondition | undefined
  onChange: (c: FlowCondition | undefined) => void
  fallback: FlowCondition
  variablesOnly?: boolean
  extra?: React.ReactNode
}) {
  return (
    <div className="flow-cond">
      <div className="flow-cond-row">
        <label className="flow-cond-label check-label">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? structuredClone(fallback) : undefined)} />
          {label}
        </label>
        {value ? <ConditionEditor value={value} onChange={onChange} variablesOnly={variablesOnly} /> : <span className="muted small">{hint}</span>}
      </div>
      {value && extra && <div className="flow-cond-row extra">{extra}</div>}
    </div>
  )
}

const SOURCES: { id: FlowCondition['source']; label: string }[] = [
  { id: 'variable', label: 'Variable' },
  { id: 'status', label: 'Status code' },
  { id: 'body', label: 'Body (JSON)' },
  { id: 'header', label: 'Header' },
  { id: 'cookie', label: 'Cookie' }
]

function ConditionEditor({
  value,
  onChange,
  variablesOnly
}: {
  value: FlowCondition
  onChange: (c: FlowCondition) => void
  variablesOnly?: boolean
}) {
  const set = (patch: Partial<FlowCondition>) => onChange({ ...value, ...patch })
  const op = CONDITION_OPS.find((o) => o.id === value.op)
  const placeholder =
    value.source === 'variable' ? 'name' : value.source === 'body' ? '$.data.status' : value.source === 'header' ? 'Content-Type' : 'session'
  return (
    <span className="flow-cond-editor">
      <select className="cap-input" value={value.source} onChange={(e) => set({ source: e.target.value as FlowCondition['source'] })}>
        {SOURCES.filter((s) => !variablesOnly || s.id === 'variable').map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {value.source !== 'status' && (
        <input className="cap-input mono" value={value.path} placeholder={placeholder} spellCheck={false} onChange={(e) => set({ path: e.target.value })} />
      )}
      <select className="cap-input" value={value.op} onChange={(e) => set({ op: e.target.value as FlowCondition['op'] })}>
        {CONDITION_OPS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {op?.needsValue && (
        <span className="flow-cond-value">
          <VarInput value={value.value} placeholder={value.op === 'matches' ? 'pattern, e.g. ^2' : 'value'} onChange={(v) => set({ value: v })} />
        </span>
      )}
    </span>
  )
}

function RequestPicker({ onPick, onClose }: { onPick: (collectionId: string, requestId: string) => void; onClose: () => void }) {
  const collections = useWorkspace((s) => s.collections)
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const groups = collections
    .map((c) => ({
      c,
      rows: flattenRequests(c.items).filter(
        ({ request, parents }) =>
          !query ||
          request.name.toLowerCase().includes(query) ||
          request.url.toLowerCase().includes(query) ||
          parents.some((p) => p.name.toLowerCase().includes(query))
      )
    }))
    .filter((g) => g.rows.length)
  return (
    <div className="flow-picker">
      <div className="flow-picker-head">
        <div className="panel-search inline">
          <Search size={13} />
          <input autoFocus placeholder="Find a request in the library" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
        </div>
        <button className="btn ghost small" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className="flow-picker-list">
        {groups.map(({ c, rows }) => (
          <div key={c.id}>
            <div className="panel-section">{c.name}</div>
            {rows.map(({ request, parents }) => (
              <button key={request.id} className="flow-pick-row" onClick={() => onPick(c.id, request.id)}>
                <MethodBadge method={request.method} short />
                <span className="flow-step-name">{request.name}</span>
                <span className="muted small">{parents.map((p) => p.name).join(' › ')}</span>
                <span className="muted small mono flow-pick-url">{request.url}</span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="hint pad">{collections.length ? 'No request matches.' : 'Your library is empty: save a request to a collection first.'}</p>
        )}
      </div>
    </div>
  )
}
