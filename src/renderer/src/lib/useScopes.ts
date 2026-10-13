import { useMemo, useRef } from 'react'
import { useWorkspace } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import type { ScopesRef } from '../components/editor/variables'
import { toMap, type Scopes } from '@shared/engine/variables'

/**
 * Live variable scopes for editors, as a stable ref (CodeMirror extensions read
 * it lazily). A tab's temporary values form the "local" scope, as when sending.
 */
export function useScopes(collectionId: string | null, tabId: string | null = null): ScopesRef {
  const globals = useWorkspace((s) => s.globals)
  const collectionVars = useWorkspace((s) => s.collections.find((c) => c.id === collectionId)?.variables)
  const envVars = useWorkspace((s) => s.environments.find((e) => e.id === s.activeEnvironmentId)?.variables)
  const tabVars = useRuntime((s) => (tabId ? s.tabVars[tabId] : undefined))
  const scopes = useMemo<Scopes>(
    () => ({ globals: toMap(globals), collection: toMap(collectionVars), environment: toMap(envVars), data: {}, local: { ...tabVars } }),
    [globals, collectionVars, envVars, tabVars]
  )
  const ref = useRef<ScopesRef>({ current: scopes })
  ref.current.current = scopes
  ref.current.ctx = { collectionId, tabId }
  return ref.current
}
