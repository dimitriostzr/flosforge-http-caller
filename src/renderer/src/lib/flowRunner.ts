import { runFlow } from '@shared/engine/flowRun'
import { toMap } from '@shared/engine/variables'
import { activeEnvironment, useWorkspace } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { toast } from '../store/dialogs'
import { appEngine, execOptions } from './runner'

/** Runs a flow from its tab; step results stream into the runtime store. */
export async function runFlowById(flowId: string, keepVariables = true): Promise<void> {
  const ws = useWorkspace.getState()
  const flow = ws.flows.find((f) => f.id === flowId)
  if (!flow) return
  if (!flow.steps.some((s) => s.enabled)) return toast('Add a step to the flow first', 'error')
  const rt = useRuntime.getState()
  if (rt.flowRuns[flowId]?.status === 'running') return
  // Earlier results stay visible (dimmed) until their step runs again.
  rt.setFlowRun(flowId, (prev) => ({
    status: 'running',
    startedAt: Date.now(),
    results: {},
    previous: { ...prev?.previous, ...prev?.results }
  }))

  const env = activeEnvironment(ws)
  const start = { globals: toMap(ws.globals), collection: {}, environment: toMap(env?.variables), data: {}, local: {} }
  const summary = await runFlow({
    flow: structuredClone(flow),
    collections: ws.collections,
    scopes: start,
    opts: execOptions(ws.settings),
    scriptTimeoutMs: ws.settings.scriptTimeoutMs,
    environmentActive: !!env,
    deps: appEngine,
    onStep: (r) => useRuntime.getState().setFlowRun(flowId, (run) => run && { ...run, results: { ...run.results, [r.stepId]: r } }),
    onProgress: (progress) => useRuntime.getState().setFlowRun(flowId, (run) => run && { ...run, progress }),
    isCancelled: () => !!useRuntime.getState().flowRuns[flowId]?.cancelRequested
  })

  if (keepVariables) {
    const w = useWorkspace.getState()
    w.applyScriptScopes(null, start, summary.scopes)
    for (const [collectionId, after] of Object.entries(summary.collections)) {
      const c = w.collections.find((x) => x.id === collectionId)
      if (!c) continue
      const before = toMap(c.variables)
      w.applyScriptScopes(collectionId, { globals: {}, environment: {}, collection: before }, { globals: {}, environment: {}, collection: after })
    }
  }
  useRuntime.getState().setFlowRun(flowId, (run) => run && { ...run, status: 'done', progress: undefined, summary, cancelRequested: false })
}

export function stopFlow(flowId: string): void {
  useRuntime.getState().setFlowRun(flowId, (r) => r && { ...r, cancelRequested: true })
}
