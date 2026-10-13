import { cloneWithNewIds, emptyBody, emptyScripts, newCollection, newEnvironment, uid } from '../model'
import type { ApiRequest, Collection, Environment, TreeItem, Variable } from '../types'
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
    it.body = { ...emptyBody(), ...it.body }
    it.method ||= 'GET'
    it.url ??= ''
  }
}

function regenVarIds(vars: unknown): Variable[] {
  return Array.isArray(vars) ? vars.filter(isObj).map((v) => ({ ...(v as Variable), id: uid() })) : []
}

function importNative(o: Record<string, Json>, out: ImportResult): void {
  for (const c of Array.isArray(o.collections) ? o.collections : []) {
    if (!isObj(c)) continue
    const items = (Array.isArray(c.items) ? c.items : [])
      .filter((it: unknown) => isObj(it) && (it.kind === 'request' || it.kind === 'folder'))
      .map((it: TreeItem) => cloneWithNewIds(it))
    items.forEach(normalizeItem)
    out.collections.push(
      newCollection({
        ...c,
        id: uid(),
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
}

/** Produces a backup file in the app's own format (re-importable with importText). */
export function exportNative(collections: Collection[], environments: Environment[]): object {
  const data: NativeExport = {
    flosforgeCaller: NATIVE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    collections,
    environments
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
