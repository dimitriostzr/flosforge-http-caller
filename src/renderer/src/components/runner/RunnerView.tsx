import { useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  MinusCircle,
  Play,
  Square,
  X,
  XCircle
} from 'lucide-react'
import { parseDataFile } from '@shared/engine/data'
import type { RunStep } from '@shared/engine/collectionRun'
import { activeEnvironment, useWorkspace, type RunnerTab } from '../../store/workspace'
import { useRuntime } from '../../store/runtime'
import { toast } from '../../store/dialogs'
import { runTarget, startRun, stopRun } from '../../lib/collectionRunner'
import { exportRun } from '../../lib/exports'
import { REPORT_FORMATS } from '@shared/engine/exports'
import { formatBytes, formatMs, statusTone } from '../../lib/format'
import { Empty, MethodBadge, Toggle, openMenu } from '../ui'

export function RunnerView({ tab }: { tab: RunnerTab }) {
  // Re-read the target when the collection changes (requests added, renamed, moved).
  useWorkspace((s) => s.collections.find((c) => c.id === tab.collectionId))
  const target = runTarget(tab)
  const run = useRuntime((s) => s.runs[tab.id])
  const envName = useWorkspace((s) => activeEnvironment(s)?.name)
  const update = useWorkspace((s) => s.updateRunnerConfig)
  const setConfig = (recipe: Parameters<typeof update>[1]) => update(tab.id, recipe)
  const { config } = tab
  const running = run?.status === 'running'

  if (!target) return <Empty title="Nothing to run">This collection or folder no longer exists.</Empty>

  const isSelected = (id: string) => !config.selected || config.selected.includes(id)
  const selectedCount = target.items.filter((i) => isSelected(i.request.id)).length
  const toggle = (id: string) =>
    setConfig((c) => {
      const all = target.items.map((i) => i.request.id)
      const current = c.selected ?? all
      const next = current.includes(id) ? current.filter((x) => x !== id) : all.filter((x) => x === id || current.includes(x))
      c.selected = next.length === all.length ? null : next
    })

  const chooseData = async () => {
    const [file] = await window.api.openFiles('Choose a CSV or JSON data file')
    if (!file) return
    try {
      const parsed = parseDataFile(file.content, file.name)
      setConfig((c) => void (c.data = { name: file.name, ...parsed }))
      toast(`${parsed.rows.length} rows: one iteration each`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="runner-view">
      <div className="runner-header">
        <Play size={18} className="collection-icon" />
        <h2>
          {target.name}
          {tab.folderId && <span className="muted small"> in {target.collection.name}</span>}
        </h2>
        <span className="muted small">
          {envName ? `Environment: ${envName}` : 'No environment'} · {selectedCount} of {target.items.length} requests
        </span>
        <div className="spacer" />
        {running ? (
          <button className="btn danger" onClick={() => stopRun(tab.id)}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => void startRun(tab.id)} disabled={!selectedCount}>
            <Play size={14} /> {run ? 'Run again' : 'Run'}
          </button>
        )}
      </div>

      <div className="runner-body">
        <aside className="runner-config">
          <section>
            <div className="runner-section-head">
              <h4>Requests</h4>
              <button className="link small" onClick={() => setConfig((c) => void (c.selected = null))}>
                All
              </button>
              <button className="link small" onClick={() => setConfig((c) => void (c.selected = []))}>
                None
              </button>
            </div>
            <div className="runner-requests">
              {target.items.map(({ request, parents }) => (
                <label key={request.id} className="runner-request">
                  <input type="checkbox" checked={isSelected(request.id)} onChange={() => toggle(request.id)} disabled={running} />
                  <MethodBadge method={request.method} short />
                  <span className="runner-request-name">
                    {parents.length > (tab.folderId ? 1 : 0) && (
                      <span className="muted">
                        {parents
                          .slice(tab.folderId ? 1 : 0)
                          .map((p) => p.name)
                          .join(' / ')}{' '}
                        /{' '}
                      </span>
                    )}
                    {request.name}
                  </span>
                </label>
              ))}
              {!target.items.length && <p className="hint">This {tab.folderId ? 'folder' : 'collection'} has no requests yet.</p>}
            </div>
          </section>

          <section>
            <h4>Iterations</h4>
            {config.data ? (
              <div className="runner-data">
                <FileSpreadsheet size={16} />
                <div>
                  <div className="runner-data-name">{config.data.name}</div>
                  <div className="muted small">
                    {config.data.rows.length} rows → {config.data.rows.length} iterations. Columns:{' '}
                    {config.data.columns.map((c) => `{{${c}}}`).join(' ')}
                  </div>
                </div>
                <button className="icon-btn" title="Remove data file" onClick={() => setConfig((c) => void (c.data = null))} disabled={running}>
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="setting-row">
                <span>Run everything</span>
                <input
                  className="text-input num"
                  type="number"
                  min={1}
                  max={10000}
                  value={config.iterations}
                  disabled={running}
                  onChange={(e) => setConfig((c) => void (c.iterations = Math.max(1, Math.min(10000, Number(e.target.value) || 1))))}
                />
              </div>
            )}
            {!config.data && (
              <button className="btn secondary small" onClick={() => void chooseData()} disabled={running}>
                <FileSpreadsheet size={13} /> Use a data file (CSV or JSON)
              </button>
            )}
            <p className="hint">Each row of a data file is one iteration; its columns become variables.</p>
          </section>

          <section>
            <h4>Options</h4>
            <div className="setting-row">
              <span>
                Delay between requests <span className="muted small">(ms)</span>
              </span>
              <input
                className="text-input num"
                type="number"
                min={0}
                step={100}
                value={config.delayMs}
                disabled={running}
                onChange={(e) => setConfig((c) => void (c.delayMs = Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            <div className="setting-row">
              <span>Stop at the first failure</span>
              <Toggle checked={config.bail} onChange={(v) => setConfig((c) => void (c.bail = v))} />
            </div>
            <div className="setting-row">
              <span title="Variables that scripts set during the run are saved to the environment, collection and globals">
                Keep variable changes
              </span>
              <Toggle checked={config.persistVariables} onChange={(v) => setConfig((c) => void (c.persistVariables = v))} />
            </div>
          </section>
        </aside>

        <section className="runner-results">
          {!run ? (
            <Empty icon={<Play size={30} strokeWidth={1.4} />} title="Ready to run">
              <p>
                Requests run in order, top to bottom. Variables set by one request’s scripts are available to the next, so a
                login request can feed the rest of the flow.
              </p>
              <p>Scripts can call pm.execution.setNextRequest("Name") to jump, or setNextRequest(null) to stop.</p>
            </Empty>
          ) : (
            <RunResults tabId={tab.id} />
          )}
        </section>
      </div>
    </div>
  )
}

function RunResults({ tabId }: { tabId: string }) {
  const run = useRuntime((s) => s.runs[tabId])!
  const [filter, setFilter] = useState<'all' | 'failed'>('all')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const s = run.summary
  const done = run.status === 'done'

  const passedTests = run.steps.reduce((n, x) => n + x.tests.filter((t) => t.passed && !t.skipped).length, 0)
  const failedTests = run.steps.reduce((n, x) => n + x.tests.filter((t) => !t.passed && !t.skipped).length, 0)
  const failedSteps = run.steps.filter((x) => !x.passed).length
  const timed = run.steps.filter((x) => x.timeMs !== undefined)
  const avg = timed.length ? timed.reduce((n, x) => n + x.timeMs!, 0) / timed.length : undefined
  const elapsed = (s?.finishedAt ?? Date.now()) - run.startedAt

  const groups = useMemo(() => {
    const shown = run.steps.map((step, i) => ({ step, i })).filter(({ step }) => filter === 'all' || !step.passed)
    const byIteration = new Map<number, typeof shown>()
    for (const x of shown) {
      if (!byIteration.has(x.step.iteration)) byIteration.set(x.step.iteration, [])
      byIteration.get(x.step.iteration)!.push(x)
    }
    return [...byIteration.entries()]
  }, [run.steps, filter])

  return (
    <div className="run-results">
      {run.status === 'running' && (
        <div className="run-progress">
          <Loader2 size={15} className="spin" />
          <span>
            Iteration {(run.progress?.iteration ?? 0) + 1} of {run.totalIterations}
            {run.progress && (
              <>
                {' '}
                · <b>{run.progress.name}</b>
              </>
            )}
          </span>
          <div className="run-progress-bar">
            <span style={{ width: `${(((run.progress?.iteration ?? 0) + (run.progress ? 0.5 : 0)) / run.totalIterations) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="run-cards">
        <div className={`run-card ${failedSteps ? 'bad' : done ? 'good' : ''}`}>
          <div className="run-card-value">
            {run.steps.length - failedSteps}/{run.steps.length}
          </div>
          <div className="run-card-label">requests passed</div>
        </div>
        <div className={`run-card ${failedTests ? 'bad' : passedTests && done ? 'good' : ''}`}>
          <div className="run-card-value">
            {passedTests}/{passedTests + failedTests}
          </div>
          <div className="run-card-label">tests passed</div>
        </div>
        <div className="run-card">
          <div className="run-card-value">{formatMs(avg)}</div>
          <div className="run-card-label">average response</div>
        </div>
        <div className="run-card">
          <div className="run-card-value">{formatMs(elapsed)}</div>
          <div className="run-card-label">{done ? 'total time' : 'elapsed'}</div>
        </div>
      </div>
      {s?.note && <div className={`banner ${s.stoppedBecause === 'cancelled' ? '' : 'warn'}`}>{s.note}</div>}
      {s?.stoppedBecause === 'cancelled' && <div className="banner">Stopped before the run finished.</div>}

      <div className="run-toolbar">
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>
            Failed {failedSteps ? `(${failedSteps})` : ''}
          </button>
        </div>
        <div className="spacer" />
        {done && (
          <button
            className="btn ghost small"
            onClick={(e) =>
              openMenu(e, [
                ...REPORT_FORMATS.map((f) => ({ label: f.label, onClick: () => void exportRun(tabId, f.id) })),
                { separator: true as const },
                { label: 'JUnit XML (for CI)', onClick: () => void exportRun(tabId, 'junit') }
              ])
            }
          >
            <Download size={13} /> Export report
          </button>
        )}
      </div>

      <div className="run-list">
        {groups.map(([iteration, rows]) => (
          <div key={iteration}>
            {run.totalIterations > 1 && <div className="run-iteration">Iteration {iteration + 1}</div>}
            {rows.map(({ step, i }) => (
              <StepRow
                key={i}
                step={step}
                open={open.has(i)}
                onToggle={() =>
                  setOpen((o) => {
                    const n = new Set(o)
                    if (n.has(i)) n.delete(i)
                    else n.add(i)
                    return n
                  })
                }
              />
            ))}
          </div>
        ))}
        {filter === 'failed' && !failedSteps && done && <p className="hint pad">Nothing failed. 🎉</p>}
      </div>
    </div>
  )
}

function StepRow({ step, open, onToggle }: { step: RunStep; open: boolean; onToggle: () => void }) {
  const passed = step.tests.filter((t) => t.passed && !t.skipped).length
  const total = step.tests.filter((t) => !t.skipped).length
  return (
    <div className={`run-step ${step.passed ? '' : 'failed'}`}>
      <button className="run-step-row" onClick={onToggle}>
        <ChevronRight size={13} className={`chev ${open ? 'open' : ''}`} />
        {step.skipped ? (
          <MinusCircle size={15} className="muted" />
        ) : step.passed ? (
          <CheckCircle2 size={15} className="ok" />
        ) : (
          <XCircle size={15} className="bad" />
        )}
        <MethodBadge method={step.method} short />
        <span className="run-step-name">{step.name}</span>
        {step.status !== undefined ? (
          <span className={`status-pill small tone-${statusTone(step.status)}`}>{step.status}</span>
        ) : (
          <span className="status-pill small tone-server">{step.skipped ? 'skipped' : 'ERR'}</span>
        )}
        <span className="run-step-meta">{formatMs(step.timeMs)}</span>
        <span className="run-step-meta">{step.sizeBytes !== undefined ? formatBytes(step.sizeBytes) : ''}</span>
        <span className={`run-step-tests ${passed < total ? 'bad' : total ? 'ok' : 'muted'}`}>{total ? `${passed}/${total}` : '—'}</span>
      </button>
      {open && (
        <div className="run-step-detail">
          <div className="mono small run-step-url">
            {step.method} {step.url}
          </div>
          {step.error && <div className="test-error">{step.error}</div>}
          {step.scriptErrors.map((e, i) => (
            <div key={i} className="test-error">
              {e}
            </div>
          ))}
          {step.tests.map((t, i) => (
            <div key={i} className={`test-row ${t.skipped ? 'skipped' : t.passed ? 'pass' : 'fail'}`}>
              {t.skipped ? <MinusCircle size={14} /> : t.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              <div>
                <div className="test-name">{t.name}</div>
                {t.error && <div className="test-error">{t.error}</div>}
              </div>
            </div>
          ))}
          {step.logs.length > 0 && (
            <div className="logs">
              {step.logs.map((l, i) => (
                <div key={i} className={`log-row log-${l.level}`}>
                  <span className="log-source">{l.source}</span>
                  <pre className="log-msg">{l.message}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
