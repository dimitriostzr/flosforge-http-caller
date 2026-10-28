import { cloneWithNewIds, emptyBody, emptyScripts, newCapture, newCollection, newEnvironment, uid } from '../model'
import type { ApiRequest, Collection, Environment, Flow, FlowStep, TreeItem, Variable } from '../types'
import { parseCurl } from './curl'
import {
  exportCollectionV21,
  exportEnvironmentFile,
  importCollectionV2,
  importDataDump,
  importEnvironmentFile,
  importGlobalsFile,
  importCollectionV1,
  isDataDump,
  isEnvironmentFile,
  isGlobalsFile,
  isCollectionV1,
  isCollectionV2
} from './collectionFormat'

export { parseCurl, exportCollectionV21, exportEnvironmentFile }

export interface ImportResult {
  collections: Collection[]
  environments: Environment[]
  globals: Variable[]
  /** Set when the input was a single cURL command. */
  request?: ApiRequest
  /** From backups; their steps point at the imported collections' new ids. */
  flows?: Flow[]
  warnings: string[]
}

export const NATIVE_FORMAT_VERSION = 1

export interface NativeExport {
  flosforgeCaller: number
  exportedAt: string
  collections: Collection[]
  environments: Environment[]
  /** Loose requests (a single exported request). Imported as an open tab, or a collection if several. */
  requests?: ApiRequest[]
  flows?: Flow[]
}

const UNRECOGNIZED =
  'Unrecognized format: expected a collection, environment, globals or data dump, or a cURL command'

// Untrusted parsed JSON.
type Json = any

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** "Users API.collection.json" (or "Users API.<tool>_collection.json") → "Users API" */
function baseName(fileName?: string): string | undefined {
  if (!fileName) return undefined
  const name = fileName
    .split(/[\\/]/)
    .pop()!
    .replace(/\.json$/i, '')
    .replace(/\.(?:[a-z]+_)?(?:collection|environment|globals|dump)$/i, '')
  return name || undefined
}

// ---------------------------------------------------------------------------
// Native format

/** Fills fields missing from older/hand-edited native exports. */
function normalizeItem(it: TreeItem): void {
  it.scripts = { ...emptyScripts(), ...it.scripts }
  it.auth = it.auth?.type ? it.auth : { type: 'inherit' }
  it.description ??= ''
  if (it.kind === 'folder') {
    it.items = Array.isArray(it.items) ? it.items.filter(isObj) : []
    it.items.forEach(normalizeItem)
  } else {
    it.params = Array.isArray(it.params) ? it.params : []
    it.headers = Array.isArray(it.headers) ? it.headers : []
    if (it.pathVariables !== undefined && !Array.isArray(it.pathVariables)) delete it.pathVariables
    if (it.captures !== undefined) {
      if (Array.isArray(it.captures)) it.captures = it.captures.filter(isObj).map((c) => ({ ...newCapture(), ...c }))
      else delete it.captures
    }
    it.body = { ...emptyBody(), ...it.body }
    it.method ||= 'GET'
    it.url ??= ''
  }
}

function regenVarIds(vars: unknown): Variable[] {
  return Array.isArray(vars) ? vars.filter(isObj).map((v) => ({ ...(v as Variable), id: uid() })) : []
}

/** Records old id → new id for an item copied with cloneWithNewIds, and for everything inside it. */
function mapIds(orig: TreeItem, copy: TreeItem, ids: Map<string, string>): void {
  ids.set(orig.id, copy.id)
  if (orig.kind === 'folder' && copy.kind === 'folder' && Array.isArray(orig.items))
    orig.items.forEach((child, i) => copy.items[i] && mapIds(child, copy.items[i], ids))
}

function importNative(o: Record<string, Json>, out: ImportResult): void {
  // Everything gets fresh ids; flows follow their requests through this map.
  const ids = new Map<string, string>()
  for (const c of Array.isArray(o.collections) ? o.collections : []) {
    if (!isObj(c)) continue
    const items = (Array.isArray(c.items) ? c.items : [])
      .filter((it: unknown) => isObj(it) && (it.kind === 'request' || it.kind === 'folder'))
      .map((it: TreeItem) => {
        const copy = cloneWithNewIds(it)
        mapIds(it, copy, ids)
        return copy
      })
    items.forEach(normalizeItem)
    const id = uid()
    if (typeof c.id === 'string') ids.set(c.id, id)
    out.collections.push(
      newCollection({
        ...c,
        id,
        items,
        variables: regenVarIds(c.variables),
        scripts: { ...emptyScripts(), ...c.scripts },
        auth: c.auth?.type ? c.auth : { type: 'none' }
      })
    )
  }
  for (const e of Array.isArray(o.environments) ? o.environments : []) {
    if (!isObj(e)) continue
    out.environments.push(newEnvironment({ name: e.name || 'Imported environment', variables: regenVarIds(e.variables) }))
  }
  if (Array.isArray(o.globals)) out.globals.push(...regenVarIds(o.globals))
  const requests = (Array.isArray(o.requests) ? o.requests : [])
    .filter((r: unknown) => isObj(r) && r.kind === 'request')
    .map((r: ApiRequest) => cloneWithNewIds(r))
  requests.forEach(normalizeItem)
  if (requests.length === 1) out.request = requests[0] as ApiRequest
  else if (requests.length > 1) out.collections.push(newCollection({ name: 'Imported requests', items: requests }))

  const flows = (Array.isArray(o.flows) ? o.flows : []).filter(isObj).map(
    (f): Flow => ({
      id: uid(),
      name: typeof f.name === 'string' && f.name ? f.name : 'Imported flow',
      description: typeof f.description === 'string' ? f.description : '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: (Array.isArray(f.steps) ? f.steps : []).filter(isObj).map(
        (st): FlowStep => ({
          ...(st as FlowStep),
          id: uid(),
          kind: st.kind === 'delay' ? 'delay' : 'request',
          enabled: st.enabled !== false,
          // Steps for requests outside this file keep their ids: they may exist where it's imported.
          collectionId: ids.get(st.collectionId) ?? st.collectionId,
          requestId: ids.get(st.requestId) ?? st.requestId
        })
      )
    })
  )
  if (flows.length) out.flows = [...(out.flows ?? []), ...flows]
}

/** Produces a backup file in the app's own format (re-importable with importText). */
export function exportNative(collections: Collection[], environments: Environment[], flows: Flow[] = []): object {
  const data: NativeExport = {
    flosforgeCaller: NATIVE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
    environments,
    ...(flows.length ? { flows } : {})
  }
  return structuredClone(data)
}

// ---------------------------------------------------------------------------
// Detection

function importJson(o: unknown, out: ImportResult, fallbackName?: string): boolean {
  if (!isObj(o)) return false
  // `dispatch` is the key used before the app was renamed.
  if (typeof o.flosforgeCaller === 'number' || typeof o.dispatch === 'number') {
    importNative(o, out)
  } else if (isDataDump(o)) {
    const d = importDataDump(o, out.warnings)
    out.collections.push(...d.collections)
    out.environments.push(...d.environments)
    out.globals.push(...d.globals)
  } else if (isCollectionV2(o)) {
    out.collections.push(importCollectionV2(o, out.warnings, fallbackName))
  } else if (isCollectionV1(o)) {
    out.collections.push(importCollectionV1(o, out.warnings, fallbackName))
  } else if (isGlobalsFile(o)) {
    out.globals.push(...importGlobalsFile(o))
  } else if (isEnvironmentFile(o)) {
    out.environments.push(importEnvironmentFile(o, fallbackName))
  } else if (isCollectionV2(o.collection)) {
    // Some API responses wrap the payload: { collection: {...} } / { environment: {...} }
    out.collections.push(importCollectionV2(o.collection, out.warnings, fallbackName))
  } else if (isEnvironmentFile(o.environment)) {
    out.environments.push(importEnvironmentFile(o.environment, fallbackName))
  } else {
    return false
  }
  return true
}

/** Imports any supported file content: collection exports, our own backups or a cURL command. */
export function importText(text: string, fileName?: string): ImportResult {
  const out: ImportResult = { collections: [], environments: [], globals: [], warnings: [] }
  const trimmed = text.replace(/^﻿/, '').trim()
  if (/^curl(\.exe)?(\s|$|\^)/i.test(trimmed)) {
    out.request = parseCurl(trimmed)
    return out
  }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    throw new Error('File is not valid JSON')
  }
  const fallback = baseName(fileName)
  if (Array.isArray(data)) {
    let recognized = 0
    data.forEach((entry, i) => {
      if (importJson(entry, out, fallback)) recognized++
      else out.warnings.push(`Skipped entry #${i + 1}: unrecognized format`)
    })
    if (!recognized) throw new Error(UNRECOGNIZED)
  } else if (!importJson(data, out, fallback)) {
    throw new Error(UNRECOGNIZED)
  }
  return out
}
