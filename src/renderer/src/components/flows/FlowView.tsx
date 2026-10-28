import { useMemo, useRef, useState } from 'react'
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
import { CONDITION_OPS, describeCondition, stepRequest, variablesBefore, type FlowStepResult } from '@shared/engine/flowRun'
import { effectiveAuth } from '@shared/engine/prepare'
import { lookup } from '@shared/engine/variables'
import { requestVariables } from '@shared/variableUsage'
import { useWorkspace, type FlowTab } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { toast } from '../../store/dialogs'
import { runFlowById, stopFlow } from '../../lib/flowRunner'
import { formatMs } from '../../lib/format'
import { useScopes } from '../../lib/useScopes'
import { VarScopesContext, useScopesRef } from '../editor/variables'
import { VarInput } from '../editor/VarInput'
import { KeyValueEditor } from '../KeyValueEditor'
import { CapturesEditor } from '../request/CapturesEditor'
import { Empty, InlineEdit, MethodBadge, Splitter } from '../ui'
import { FlowResults } from './FlowResults'

/** A variable an earlier step sets, with the value it had in the last run when there is one. */
interface Earlier {
  name: string
  stepIndex: number
  stepName: string
  how: 'capture' | 'script'
  value?: string
}

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
  const [selected, setSelected] = useState<string | null>(null)
  const layout = useWorkspace((s) => s.settings.layout)
  const splitRatio = useWorkspace((s) => s.splitRatio)
  const setSplitRatio = useWorkspace((s) => s.setSplitRatio)
  const containerRef = useRef<HTMLDivElement>(null)
  const startRatio = useRef(splitRatio)
  const collections = useWorkspace((s) => s.collections)
  // What each step can use from the steps before it, with last-run values.
  const earlier = useMemo(() => {
    if (!flow) return []
    return flow.steps.map((_, i) =>
      variablesBefore(flow, i, collections).map((v): Earlier => {
        const r = run?.results[flow.steps[v.stepIndex].id] ?? run?.previous[flow.steps[v.stepIndex].id]
        return { ...v, value: r?.captures.find((c) => c.variable === v.name && !c.error)?.value }
      })
    )
  }, [flow, collections, run])
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
        <div ref={containerRef} className={`split split-${layout}`}>
        <div className="split-a" style={{ flexBasis: `${splitRatio * 100}%` }}>
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
                  earlier={earlier[i] ?? []}
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
                  onShowResult={() => setSelected(step.id)}
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
          <Splitter
            direction={layout === 'side' ? 'vertical' : 'horizontal'}
            onDrag={(delta) => {
              const el = containerRef.current
              if (!el) return
              const size = layout === 'side' ? el.clientWidth : el.clientHeight
              setSplitRatio(startRatio.current + delta / size)
            }}
            onStart={() => (startRatio.current = useWorkspace.getState().splitRatio)}
          />
          <div className="split-b">
            <FlowResults flow={flow} run={run} selectedId={selected} onSelect={setSelected} onRun={() => void runFlowById(flow.id, keepVariables)} />
          </div>
        </div>
      </div>
    </VarScopesContext.Provider>
  )
}

function ResultBadge({
  result,
  stale,
  active,
  attempt,
  onClick
}: {
  result?: FlowStepResult
  stale: boolean
  active: boolean
  attempt: number
  onClick: () => void
}) {
  if (active)
    return (
      <span className="flow-result running">
        <Loader2 size={13} className="spin" /> {attempt > 1 ? `try ${attempt}` : 'running'}
      </span>
    )
  if (!result) return null
  const cls = `flow-result ${stale ? 'stale' : ''} ${result.skipped ? 'skipped' : result.passed ? 'pass' : 'fail'}`
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClick()
  }
  if (result.skipped)
    return (
      <button className={cls} title={`${result.skipped}. Click to see it in the results.`} onClick={open}>
        <MinusCircle size={13} /> skipped
      </button>
    )
  return (
    <button className={cls} title={`${result.error ? `${result.error}. ` : stale ? 'From the previous run. ' : ''}Click to see the result.`} onClick={open}>
      {result.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {result.status !== undefined && <b>{result.status}</b>}
      {result.timeMs !== undefined && <span>{formatMs(result.timeMs)}</span>}
      {result.attempts > 1 && <span>×{result.attempts}</span>}
      {result.status === undefined && !result.passed && <span>failed</span>}
    </button>
  )
}

function StepCard({
  step,
  index,
  count,
  result,
  earlier,
  stale,
  active,
  attempt,
  open,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onShowResult
}: {
  step: FlowStep
  index: number
  count: number
  result?: FlowStepResult
  earlier: Earlier[]
  stale: boolean
  active: boolean
  attempt: number
  open: boolean
  onToggle: () => void
  onChange: (recipe: (s: FlowStep) => void) => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
  onShowResult: () => void
}) {
  const collections = useWorkspace((s) => s.collections)
  const openRequest = useWorkspace((s) => s.openRequest)
  const target = step.kind === 'request' ? stepRequest(step, collections) : null
  // The step's editors know its collection's variables and everything earlier steps set.
  const scopes = useScopes(target?.collection.id ?? null)
  scopes.extra = Object.fromEntries(
    earlier.map((v) => [
      v.name,
      {
        value: v.value,
        label: `${v.how === 'capture' ? 'Captured' : 'Set by a script'} in step ${v.stepIndex + 1}, ${v.stepName}`,
        short: `step ${v.stepIndex + 1}`
      }
    ])
  )
  const earlierNames = earlier.map((v) => v.name)
  // What the request reads when sent, so each one can be given a value from an earlier step.
  const needs = target ? requestVariables(target.request, effectiveAuth(target.request, target.parents, target.collection)) : []
  const unusedValues = (step.variables ?? []).filter((v) => v.enabled && v.key.trim() && !needs.includes(v.key.trim()))
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
        <ResultBadge result={result} stale={stale} active={active} attempt={attempt} onClick={onShowResult} />
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
        <VarScopesContext.Provider value={scopes}>
        <div className="flow-step-body">
          {result && (
            <p className="hint flow-last-run">
              {stale ? 'Previous run' : 'Last run'}:{' '}
              {result.skipped ?? (result.passed ? 'passed' : (result.error ?? 'failed'))}
              {result.status !== undefined && ` · ${result.status}`}
              {result.timeMs !== undefined && ` · ${formatMs(result.timeMs)}`}{' '}
              <button className="link" onClick={onShowResult}>
                See the result
              </button>
            </p>
          )}
          {earlier.length > 0 && <EarlierChips earlier={earlier} />}
          {needs.length > 0 && <StepNeeds needs={needs} step={step} earlier={earlier} onChange={onChange} />}

          <section>
            <h4 className="kv-section-title">Values for this step</h4>
            <KeyValueEditor
              rows={step.variables ?? []}
              onChange={(rows) => onChange((s) => void (s.variables = rows))}
              create={(id) => ({ ...kv(), id })}
              keyPlaceholder="variable"
              valuePlaceholder="value ({{variables}} allowed)"
              keySuggestions={[...new Set([...needs, ...earlierNames])]}
            />
            {unusedValues.length > 0 && (
              <p className="hint warn-text">
                This request doesn’t read {unusedValues.map((v) => `{{${v.key.trim()}}}`).join(', ')}
                {needs.length ? `: it reads ${needs.map((n) => `{{${n}}}`).join(', ')}` : ''}. Name a value after what the
                request reads, like <code>{`${needs[0] ?? 'postId'} = {{${unusedValues[0].key.trim()}}}`}</code>.
              </p>
            )}
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
              names={earlierNames}
              variablesOnly
              onChange={(c) => onChange((s) => void (c ? (s.runIf = c) : delete s.runIf))}
              fallback={DEFAULT_RUN_IF}
            />
            <OptionalCondition
              label="Repeat until"
              hint="Sends again until this holds on the response, for polling a job or waiting for a status."
              value={step.repeatUntil?.condition}
              names={earlierNames}
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
              names={earlierNames}
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
        </VarScopesContext.Provider>
      )}
    </li>
  )
}

/**
 * The variables the step's request reads, each with where its value will come
 * from, and a quick way to take it from an earlier step instead.
 */
function StepNeeds({
  needs,
  step,
  earlier,
  onChange
}: {
  needs: string[]
  step: FlowStep
  earlier: Earlier[]
  onChange: (recipe: (s: FlowStep) => void) => void
}) {
  const scopes = useScopesRef()
  const use = (name: string, value: string) =>
    onChange((s) => {
      const vars = (s.variables ??= [])
      const row = vars.find((v) => v.key.trim() === name)
      if (row) Object.assign(row, { value, enabled: true })
      else vars.push({ ...kv(name, value), id: uid() })
    })
  const clear = (name: string) =>
    onChange((s) => {
      s.variables = (s.variables ?? []).filter((v) => v.key.trim() !== name)
      if (!s.variables.length) delete s.variables
    })
  return (
    <section>
      <h4 className="kv-section-title">This request needs</h4>
      <div className="flow-needs">
        {needs.map((name) => {
          const own = step.variables?.find((v) => v.enabled && v.key.trim() === name)
          const before = earlier.find((e) => e.name === name)
          const scoped = lookup(scopes.current, name)
          const from = own ? (
            <>
              this step: <code>{own.value || '(empty)'}</code>
            </>
          ) : before ? (
            <>
              captured in step {before.stepIndex + 1}
              {before.value !== undefined && (
                <>
                  : <code>{before.value}</code>
                </>
              )}
            </>
          ) : scoped ? (
            <>
              {scoped.source === 'dynamic' ? 'generated' : scoped.source === 'local' ? 'temporary value' : scoped.source}:{' '}
              <code>{scoped.value || '(empty)'}</code>
            </>
          ) : (
            <span className="warn-text">no value yet</span>
          )
          return (
            <div key={name} className={`flow-need ${own || before || scoped ? '' : 'missing'}`}>
              <code className="flow-need-name">{`{{${name}}}`}</code>
              <span className="flow-need-from">{from}</span>
              <select
                className="cap-input"
                value=""
                title="Where this step takes the value from"
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '__clear') clear(name)
                  else if (v === '__custom') use(name, own?.value ?? '')
                  else if (v) use(name, `{{${v}}}`)
                }}
              >
                <option value="">Use…</option>
                {earlier.length > 0 && (
                  <optgroup label="From an earlier step">
                    {earlier.map((e) => (
                      <option key={e.name} value={e.name}>
                        {`{{${e.name}}}`} · step {e.stepIndex + 1}
                        {e.value !== undefined ? ` = ${e.value.length > 30 ? `${e.value.slice(0, 30)}…` : e.value}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="__custom">A value of my own…</option>
                {own && <option value="__clear">Stop overriding it</option>}
              </select>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** What the steps before this one set, ready to use here as {{name}}. */
function EarlierChips({ earlier }: { earlier: Earlier[] }) {
  return (
    <div className="flow-earlier">
      <span className="flow-earlier-label">From earlier steps</span>
      {earlier.map((v) => (
        <button
          key={v.name}
          className="flow-earlier-chip"
          title={`${v.how === 'capture' ? 'Captured' : 'Set by a script'} in step ${v.stepIndex + 1}, ${v.stepName}. Click to copy {{${v.name}}}; or type {{ in a field to pick it.`}
          onClick={() => {
            void navigator.clipboard.writeText(`{{${v.name}}}`)
            toast(`Copied {{${v.name}}}`)
          }}
        >
          <code>{`{{${v.name}}}`}</code>
          <span className="muted">step {v.stepIndex + 1}</span>
          {v.value !== undefined && <span className="flow-earlier-value">{v.value.length > 24 ? `${v.value.slice(0, 24)}…` : v.value}</span>}
        </button>
      ))}
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
  names,
  extra
}: {
  label: string
  hint: string
  value: FlowCondition | undefined
  onChange: (c: FlowCondition | undefined) => void
  fallback: FlowCondition
  variablesOnly?: boolean
  /** Variable names to offer (from earlier steps). */
  names?: string[]
  extra?: React.ReactNode
}) {
  return (
    <div className="flow-cond">
      <div className="flow-cond-row">
        <label className="flow-cond-label check-label">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked ? structuredClone(fallback) : undefined)} />
          {label}
        </label>
        {value ? (
          <ConditionEditor value={value} onChange={onChange} variablesOnly={variablesOnly} names={names} />
        ) : (
          <span className="muted small">{hint}</span>
        )}
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
  variablesOnly,
  names = []
}: {
  value: FlowCondition
  onChange: (c: FlowCondition) => void
  variablesOnly?: boolean
  names?: string[]
}) {
  const set = (patch: Partial<FlowCondition>) => onChange({ ...value, ...patch })
  const scopes = useScopesRef()
  const [listId] = useState(() => `cond-${uid()}`)
  // Earlier steps' variables first, then what the scopes already hold.
  const options = [...new Set([...names, ...Object.keys(scopes.current.environment), ...Object.keys(scopes.current.collection), ...Object.keys(scopes.current.globals)])]
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
        <input
          className="cap-input mono"
          value={value.path}
          placeholder={placeholder}
          spellCheck={false}
          list={value.source === 'variable' ? listId : undefined}
          onChange={(e) => set({ path: e.target.value.replace(/^\{\{\s*|\s*\}\}$/g, '') })}
        />
      )}
      {value.source === 'variable' && (
        <datalist id={listId}>
          {options.map((n) => (
            <option key={n} value={n} label={names.includes(n) ? 'from an earlier step' : undefined} />
          ))}
        </datalist>
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
