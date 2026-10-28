import {
  emptyBody,
  emptyScripts,
  formField,
  inheritAuth,
  kv,
  newCollection,
  newEnvironment,
  newFolder,
  newRequest,
  noAuth,
  variable
} from '../model'
import type {
  ApiRequest,
  Auth,
  Collection,
  Environment,
  Folder,
  FormField,
  KeyValue,
  RawLanguage,
  RequestBody,
  Scripts,
  TreeItem,
  Variable
} from '../types'
import { paramsFromUrl, pathVariablesFromUrl, splitUrl, urlWithParams } from '../url'
import { capturesScript } from '../engine/captures'

// The Collection Format v1/v2.0/v2.1 (and its environment, globals and data-dump
// files). Exports in the wild are loosely typed and often hand-edited, so the input
// is treated as `any` and every access is guarded.
type Json = any

export const COLLECTION_SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

const RAW_LANGUAGES: RawLanguage[] = ['json', 'text', 'xml', 'html', 'javascript']
const UNSUPPORTED_AUTH = ['digest', 'hawk', 'awsv4', 'ntlm', 'oauth1', 'akamai', 'edgegrid', 'jwt', 'asap']

interface Ctx {
  collection: string
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Small helpers

const isObj = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Stringifies scalar values; null/undefined become ''. */
export const str = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return String(v)
}

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : [])

const desc = (d: unknown): string => {
  if (typeof d === 'string') return d
  if (isObj(d)) return str(d.content)
  return ''
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Guesses the raw body language from a content-type header or the text itself. */
export function guessRawLanguage(raw: string, contentType = ''): RawLanguage {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('html')) return 'html'
  if (ct.includes('javascript')) return 'javascript'
  if (ct) return 'text'
  const t = raw.trim()
  if (!t) return 'json'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  try {
    JSON.parse(t)
    return 'json'
  } catch {
    return 'text'
  }
}

/** Parses an old-style "Key: value\n..." header string; `//` prefixed lines are disabled. */
export function parseHeaderString(s: string): KeyValue[] {
  const out: KeyValue[] = []
  for (const line of s.split(/\r?\n/)) {
    let l = line.trim()
    if (!l) continue
    let enabled = true
    if (l.startsWith('//')) {
      enabled = false
      l = l.slice(2).trim()
    }
    const i = l.indexOf(':')
    out.push(i === -1 ? kv(l, '', enabled) : kv(l.slice(0, i).trim(), l.slice(i + 1).trim(), enabled))
  }
  return out
}

function headersFrom(h: unknown): KeyValue[] {
  if (typeof h === 'string') return parseHeaderString(h)
  return arr(h)
    .filter(isObj)
    .filter((x) => x.key !== undefined || x.value !== undefined)
    .map((x) => kv(str(x.key), str(x.value), !x.disabled && x.enabled !== false, desc(x.description) || undefined))
}

function kvListFrom(list: unknown): KeyValue[] {
  return arr(list)
    .filter(isObj)
    .map((x) => kv(str(x.key), str(x.value), !x.disabled && x.enabled !== false, desc(x.description) || undefined))
}

/** Converts variable lists (collection variables, environment values). */
export function variablesFrom(list: unknown): Variable[] {
  return arr(list)
    .filter(isObj)
    .filter((x) => x.key !== undefined || x.id !== undefined)
    .map((x) => variable(str(x.key ?? x.id), str(x.value), !x.disabled && x.enabled !== false, x.type === 'secret'))
}

const enabledFirst = <T extends { enabled: boolean }>(list: T[]): T[] => [
  ...list.filter((p) => p.enabled),
  ...list.filter((p) => !p.enabled)
]

// ---------------------------------------------------------------------------
// URL

function rebuildUrl(u: Record<string, Json>): string {
  const joinParts = (v: unknown, sep: string): string =>
    typeof v === 'string' ? v : arr(v).map((p) => (isObj(p) ? str(p.value) : str(p))).join(sep)
  let out = u.protocol ? `${str(u.protocol).replace(/:\/*$/, '')}://` : ''
  out += joinParts(u.host, '.')
  if (u.port) out += `:${str(u.port)}`
  const path = joinParts(u.path, '/')
  if (path) out += path.startsWith('/') ? path : `/${path}`
  return out
}

interface UrlFields {
  url: string
  params: KeyValue[]
  pathVariables?: KeyValue[]
}

function urlFrom(u: unknown): UrlFields {
  if (typeof u === 'string') return normalizeUrl(u, null, [])
  if (!isObj(u)) return { url: '', params: [] }
  let raw = typeof u.raw === 'string' ? u.raw : rebuildUrl(u)
  if (typeof u.raw !== 'string' && u.hash) raw += `#${str(u.hash)}`
  const query = arr(u.query).filter(isObj)
  const vars = arr(u.variable)
    .filter(isObj)
    .map((v) => kv(str(v.key ?? v.id), str(v.value), true, desc(v.description) || undefined))
  return normalizeUrl(raw, query.length > 0 ? query : null, vars)
}

function normalizeUrl(raw: string, query: Json[] | null, vars: KeyValue[]): UrlFields {
  const params = query
    ? enabledFirst(query.map((q) => kv(str(q.key), str(q.value), !q.disabled, desc(q.description) || undefined)))
    : paramsFromUrl(raw, [])
  const url = urlWithParams(raw, params)
  const pathVariables = pathVariablesFromUrl(url, vars)
  return { url, params, ...(pathVariables.length ? { pathVariables } : {}) }
}

// ---------------------------------------------------------------------------
// Body

function formdataFrom(list: unknown): FormField[] {
  return arr(list)
    .filter(isObj)
    .map((x) => {
      const isFile = x.type === 'file'
      const f = formField(str(x.key), isFile ? '' : str(x.value), isFile ? 'file' : 'text')
      f.enabled = !x.disabled && x.enabled !== false
      const d = desc(x.description)
      if (d) f.description = d
      if (isFile) {
        const src = x.src ?? x.value
        f.files = (Array.isArray(src) ? src : [src]).filter((s): s is string => typeof s === 'string' && s !== '')
      }
      if (typeof x.contentType === 'string' && x.contentType) f.contentType = x.contentType
      return f
    })
}

function bodyFrom(b: unknown, headers: KeyValue[]): RequestBody {
  const body = emptyBody()
  if (!isObj(b) || b.disabled) return body
  const ct = headers.find((h) => h.enabled && h.key.toLowerCase() === 'content-type')?.value ?? ''
  switch (b.mode) {
    case 'raw': {
      body.raw = str(b.raw)
      const lang = b.options?.raw?.language
      body.rawLanguage = RAW_LANGUAGES.includes(lang) ? lang : guessRawLanguage(body.raw, ct)
      if (body.raw !== '') body.mode = 'raw'
      break
    }
    case 'urlencoded':
      body.urlencoded = kvListFrom(b.urlencoded)
      body.mode = 'urlencoded'
      break
    case 'formdata':
      body.formdata = formdataFrom(b.formdata)
      body.mode = 'formdata'
      break
    case 'file':
      body.binaryPath = str(b.file?.src)
      body.mode = 'binary'
      break
    case 'graphql': {
      const g = isObj(b.graphql) ? b.graphql : {}
      body.graphql = {
        query: str(g.query),
        variables: typeof g.variables === 'string' ? g.variables : g.variables ? JSON.stringify(g.variables, null, 2) : ''
      }
      body.mode = 'graphql'
      break
    }
  }
  return body
}

// ---------------------------------------------------------------------------
// Auth

/** Reads auth params in v2.1 ([{key, value}]) or v2.0 ({key: value}) form. */
function authParams(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(v)) {
    for (const p of v) if (isObj(p) && p.key !== undefined) out[str(p.key)] = str(p.value)
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = str(val)
  }
  return out
}

function authFrom(a: unknown, level: 'collection' | 'item', where: string, ctx: Ctx): Auth {
  const fallback = (): Auth => (level === 'collection' ? noAuth() : inheritAuth())
  if (!isObj(a) || typeof a.type !== 'string') return fallback()
  const type = a.type
  const p = authParams(a[type])
  switch (type) {
    case 'noauth':
      return noAuth()
    case 'inherit':
      return fallback()
    case 'bearer':
      return { type: 'bearer', bearer: { token: p.token ?? '' } }
    case 'basic':
      return { type: 'basic', basic: { username: p.username ?? '', password: p.password ?? '' } }
    case 'apikey':
      return { type: 'apikey', apikey: { key: p.key ?? '', value: p.value ?? '', in: p.in === 'query' ? 'query' : 'header' } }
    case 'oauth2':
      return { type: 'oauth2', oauth2: { accessToken: p.accessToken ?? '', headerPrefix: p.headerPrefix || 'Bearer' } }
  }
  const label = UNSUPPORTED_AUTH.includes(type) ? type : `unknown (${type})`
  ctx.warnings.push(`${ctx.collection}: auth type "${label}" on "${where}" is not supported and was not imported`)
  return fallback()
}

// ---------------------------------------------------------------------------
// Scripts

const execText = (exec: unknown): string => (Array.isArray(exec) ? exec.map(str).join('\n') : str(exec))

function scriptsFrom(events: unknown): Scripts {
  const s = emptyScripts()
  for (const e of arr(events)) {
    if (!isObj(e) || e.disabled) continue
    const code = execText(isObj(e.script) ? e.script.exec : undefined)
    if (!code) continue
    if (e.listen === 'prerequest') s.preRequest = s.preRequest ? `${s.preRequest}\n${code}` : code
    else if (e.listen === 'test') s.test = s.test ? `${s.test}\n${code}` : code
  }
  return s
}

// ---------------------------------------------------------------------------
// Collection v2.0 / v2.1

const schemaOf = (o: Json): string => (isObj(o) && isObj(o.info) ? str(o.info.schema) : '')

export function isCollectionV2(o: unknown): boolean {
  if (!isObj(o) || !isObj(o.info)) return false
  return Array.isArray(o.item) || /v2\.[01]\.0/.test(schemaOf(o))
}

export function isCollectionV1(o: unknown): boolean {
  return isObj(o) && !isObj(o.info) && Array.isArray(o.requests) && (Array.isArray(o.order) || typeof o.name === 'string')
}

export function isEnvironmentFile(o: unknown): boolean {
  if (!isObj(o) || !Array.isArray(o.values)) return false
  const scope = o._postman_variable_scope
  return scope === 'environment' || (scope === undefined && typeof o.name === 'string')
}

export function isGlobalsFile(o: unknown): boolean {
  return isObj(o) && Array.isArray(o.values) && o._postman_variable_scope === 'globals'
}

export function isDataDump(o: unknown): boolean {
  return (
    isObj(o) &&
    !isObj(o.info) &&
    (Array.isArray(o.collections) || Array.isArray(o.environments)) &&
    (o.version !== undefined || Array.isArray(o.collections))
  )
}

function requestFrom(it: Record<string, Json>, ctx: Ctx): ApiRequest {
  let r: Json = it.request
  if (typeof r === 'string') r = { url: r, method: 'GET' }
  if (!isObj(r)) r = {}
  const { url, params, pathVariables } = urlFrom(r.url)
  const headers = headersFrom(r.header)
  const name = str(it.name) || url || 'Untitled request'
  return newRequest({
    name,
    method: typeof r.method === 'string' && r.method ? r.method.toUpperCase() : 'GET',
    url,
    params,
    ...(pathVariables ? { pathVariables } : {}),
    headers,
    body: bodyFrom(r.body, headers),
    auth: authFrom(r.auth, 'item', name, ctx),
    scripts: scriptsFrom(it.event),
    description: desc(r.description) || desc(it.description)
  })
}

function itemsFrom(items: unknown, ctx: Ctx, depth = 0): TreeItem[] {
  const out: TreeItem[] = []
  arr(items).forEach((it, i) => {
    try {
      if (!isObj(it)) throw new Error('not an object')
      if (Array.isArray(it.item) || (it.request === undefined && Array.isArray(it.items))) {
        if (depth > 64) throw new Error('folders nested too deeply')
        const name = str(it.name) || 'Untitled folder'
        out.push(
          newFolder({
            name,
            items: itemsFrom(it.item ?? it.items, ctx, depth + 1),
            auth: authFrom(it.auth, 'item', name, ctx),
            scripts: scriptsFrom(it.event),
            description: desc(it.description)
          })
        )
      } else {
        out.push(requestFrom(it, ctx))
      }
    } catch (e) {
      const name = isObj(it) && it.name ? `"${str(it.name)}"` : `#${i + 1}`
      ctx.warnings.push(`${ctx.collection}: skipped item ${name}: ${errMsg(e)}`)
    }
  })
  return out
}

/** Imports a Collection v2.0 / v2.1. Problems are appended to `warnings`. */
export function importCollectionV2(o: unknown, warnings: string[] = [], fallbackName?: string): Collection {
  const c = isObj(o) ? o : {}
  const info = isObj(c.info) ? c.info : {}
  const name = str(info.name) || fallbackName || 'Imported collection'
  const ctx: Ctx = { collection: name, warnings }
  const collection = newCollection({
    name,
    items: itemsFrom(c.item, ctx),
    auth: authFrom(c.auth, 'collection', name, ctx),
    scripts: scriptsFrom(c.event),
    variables: variablesFrom(c.variable),
    description: desc(info.description)
  })
  return collection
}

// ---------------------------------------------------------------------------
// Collection v1 (old exports and data dumps)

function v1Auth(r: Record<string, Json>, where: string, ctx: Ctx): Auth {
  if (isObj(r.auth)) return authFrom(r.auth, 'item', where, ctx)
  const h = isObj(r.helperAttributes) ? r.helperAttributes : {}
  if (r.currentHelper === 'basicAuth') {
    return { type: 'basic', basic: { username: str(h.username), password: str(h.password) } }
  }
  if (r.currentHelper === 'bearerAuth') return { type: 'bearer', bearer: { token: str(h.token) } }
  if (typeof r.currentHelper === 'string' && r.currentHelper !== 'normal') {
    ctx.warnings.push(`${ctx.collection}: auth helper "${r.currentHelper}" on "${where}" is not supported and was not imported`)
  }
  return inheritAuth()
}

function v1Scripts(r: Record<string, Json>): Scripts {
  if (Array.isArray(r.events) && r.events.length) return scriptsFrom(r.events)
  return { preRequest: str(r.preRequestScript), test: str(r.tests) }
}

function v1Body(r: Record<string, Json>, headers: KeyValue[]): RequestBody {
  const body = emptyBody()
  if (r.dataDisabled) return body
  const ct = headers.find((h) => h.enabled && h.key.toLowerCase() === 'content-type')?.value ?? ''
  switch (r.dataMode) {
    case 'raw': {
      body.raw = str(r.rawModeData)
      const lang = r.dataOptions?.raw?.language
      body.rawLanguage = RAW_LANGUAGES.includes(lang) ? lang : guessRawLanguage(body.raw, ct)
      if (body.raw !== '') body.mode = 'raw'
      break
    }
    case 'urlencoded':
      body.urlencoded = kvListFrom(r.data)
      body.mode = 'urlencoded'
      break
    case 'params':
      body.formdata = formdataFrom(r.data)
      body.mode = 'formdata'
      break
    case 'binary':
      body.binaryPath = typeof r.data === 'string' ? r.data : ''
      body.mode = 'binary'
      break
    case 'graphql': {
      const g = isObj(r.graphqlModeData) ? r.graphqlModeData : {}
      body.graphql = {
        query: str(g.query),
        variables: typeof g.variables === 'string' ? g.variables : g.variables ? JSON.stringify(g.variables, null, 2) : ''
      }
      body.mode = 'graphql'
      break
    }
  }
  return body
}

function v1Request(r: Record<string, Json>, ctx: Ctx): ApiRequest {
  const raw = str(r.url)
  const params = paramsFromUrl(raw, [])
  for (const q of arr(r.queryParams)) {
    if (isObj(q) && (q.enabled === false || q.disabled === true)) {
      params.push(kv(str(q.key), str(q.value), false, desc(q.description) || undefined))
    }
  }
  const headers = Array.isArray(r.headerData) && r.headerData.length ? headersFrom(r.headerData) : headersFrom(str(r.headers))
  const name = str(r.name) || raw || 'Untitled request'
  const url = urlWithParams(raw, params)
  // v1 keeps path variables twice: `pathVariableData` (with descriptions) and a plain `pathVariables` map.
  const pathVars = arr(r.pathVariableData).length
    ? arr(r.pathVariableData)
        .filter(isObj)
        .map((v) => kv(str(v.key), str(v.value), true, desc(v.description) || undefined))
    : Object.entries(isObj(r.pathVariables) ? r.pathVariables : {}).map(([k, v]) => kv(k, str(v)))
  const pathVariables = pathVariablesFromUrl(url, pathVars)
  return newRequest({
    name,
    method: typeof r.method === 'string' && r.method ? r.method.toUpperCase() : 'GET',
    url,
    params,
    ...(pathVariables.length ? { pathVariables } : {}),
    headers,
    body: v1Body(r, headers),
    auth: v1Auth(r, name, ctx),
    scripts: v1Scripts(r),
    description: desc(r.description)
  })
}

/** Best-effort import of the legacy v1 collection format (also used inside data dumps). */
export function importCollectionV1(o: unknown, warnings: string[] = [], fallbackName?: string): Collection {
  const c = isObj(o) ? o : {}
  const name = str(c.name) || fallbackName || 'Imported collection'
  const ctx: Ctx = { collection: name, warnings }

  const requests = new Map<string, Record<string, Json>>()
  for (const r of arr(c.requests)) if (isObj(r)) requests.set(str(r.id), r)
  const folders = new Map<string, Record<string, Json>>()
  for (const f of arr(c.folders)) if (isObj(f)) folders.set(str(f.id), f)

  const used = new Set<string>()
  const takeRequest = (id: string): ApiRequest | null => {
    const r = requests.get(id)
    if (!r || used.has(`r:${id}`)) return null
    used.add(`r:${id}`)
    try {
      return v1Request(r, ctx)
    } catch (e) {
      warnings.push(`${name}: skipped request "${str(r.name) || id}": ${errMsg(e)}`)
      return null
    }
  }
  const takeFolder = (id: string): Folder | null => {
    const f = folders.get(id)
    if (!f || used.has(`f:${id}`)) return null
    used.add(`f:${id}`)
    const fname = str(f.name) || 'Untitled folder'
    const items: TreeItem[] = []
    for (const sub of arr(f.folders_order)) {
      const x = takeFolder(str(sub))
      if (x) items.push(x)
    }
    for (const rid of arr(f.order)) {
      const x = takeRequest(str(rid))
      if (x) items.push(x)
    }
    return newFolder({
      name: fname,
      items,
      auth: isObj(f.auth) ? authFrom(f.auth, 'item', fname, ctx) : inheritAuth(),
      scripts: scriptsFrom(f.events),
      description: desc(f.description)
    })
  }

  // Root order; when absent, use folders/requests not referenced by any folder.
  const nestedFolders = new Set([...folders.values()].flatMap((f) => arr(f.folders_order).map(str)))
  const nestedRequests = new Set([...folders.values()].flatMap((f) => arr(f.order).map(str)))
  const rootFolders = Array.isArray(c.folders_order)
    ? c.folders_order.map(str)
    : [...folders.keys()].filter((id) => !nestedFolders.has(id) && !folders.get(id)?.folder)
  const rootRequests = Array.isArray(c.order)
    ? c.order.map(str)
    : [...requests.keys()].filter((id) => !nestedRequests.has(id) && !requests.get(id)?.folder)

  const items: TreeItem[] = []
  for (const id of rootFolders) {
    const f = takeFolder(id)
    if (f) items.push(f)
  }
  for (const id of rootRequests) {
    const r = takeRequest(id)
    if (r) items.push(r)
  }
  // Anything not reachable from the ordering is appended rather than lost.
  for (const id of folders.keys()) {
    const f = takeFolder(id)
    if (f) items.push(f)
  }
  for (const id of requests.keys()) {
    const r = takeRequest(id)
    if (r) items.push(r)
  }

  return newCollection({
    name,
    items,
    auth: isObj(c.auth) ? authFrom(c.auth, 'collection', name, ctx) : noAuth(),
    scripts: scriptsFrom(c.events),
    variables: variablesFrom(c.variables),
    description: desc(c.description)
  })
}

// ---------------------------------------------------------------------------
// Environments, globals, data dumps

export function importEnvironmentFile(o: unknown, fallbackName?: string): Environment {
  const e = isObj(o) ? o : {}
  return newEnvironment({
    name: str(e.name) || fallbackName || 'Imported environment',
    variables: variablesFrom(e.values)
  })
}

export function importGlobalsFile(o: unknown): Variable[] {
  if (Array.isArray(o)) return variablesFrom(o)
  return isObj(o) ? variablesFrom(o.values) : []
}

export interface DataDumpImport {
  collections: Collection[]
  environments: Environment[]
  globals: Variable[]
}

/** Imports a full data dump (the bulk "export data" file some API clients produce). */
export function importDataDump(o: unknown, warnings: string[] = []): DataDumpImport {
  const d = isObj(o) ? o : {}
  const out: DataDumpImport = { collections: [], environments: [], globals: [] }
  arr(d.collections).forEach((c, i) => {
    try {
      if (isCollectionV2(c)) out.collections.push(importCollectionV2(c, warnings))
      else if (isObj(c)) out.collections.push(importCollectionV1(c, warnings))
      else throw new Error('not an object')
    } catch (e) {
      warnings.push(`Skipped collection #${i + 1} in data dump: ${errMsg(e)}`)
    }
  })
  arr(d.environments).forEach((e, i) => {
    if (isObj(e)) out.environments.push(importEnvironmentFile(e))
    else warnings.push(`Skipped environment #${i + 1} in data dump: not an object`)
  })
  if (d.globals !== undefined) out.globals = importGlobalsFile(d.globals)
  return out
}

// ---------------------------------------------------------------------------
// Export (Collection v2.1.0)

/** Splits on `sep` but never inside {{variables}}. */
function splitOutsideVars(s: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i)) {
      depth++
      cur += '{{'
      i++
    } else if (depth > 0 && s.startsWith('}}', i)) {
      depth--
      cur += '}}'
      i++
    } else if (depth === 0 && s[i] === sep) {
      out.push(cur)
      cur = ''
    } else {
      cur += s[i]
    }
  }
  out.push(cur)
  return out
}

function exportUrl(url: string, params: KeyValue[], pathVariables: KeyValue[] | undefined): Json {
  const { base, hash } = splitUrl(url)
  const out: Json = { raw: url }
  let rest = base
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest)
  if (m) {
    out.protocol = m[1]
    rest = rest.slice(m[0].length)
  }
  const slash = splitOutsideVars(rest, '/')
  let hostPort = slash[0]
  const pm = /^(.*):(\d+|\{\{[^}]+\}\})$/.exec(hostPort)
  if (pm) hostPort = pm[1]
  out.host = hostPort ? splitOutsideVars(hostPort, '.') : []
  if (pm) out.port = pm[2]
  out.path = slash.slice(1)
  const query = params
    .filter((p) => p.key !== '' || p.value !== '')
    .map((p) => ({
      key: p.key,
      value: p.value,
      ...(p.enabled ? {} : { disabled: true }),
      ...(p.description ? { description: p.description } : {})
    }))
  if (query.length) out.query = query
  if (hash) out.hash = hash
  const vars = pathVariablesFromUrl(url, pathVariables).map((v) => ({
    key: v.key,
    value: v.value,
    ...(v.description ? { description: v.description } : {})
  }))
  if (vars.length) out.variable = vars
  return out
}

function exportKv(list: KeyValue[], withType = false): Json[] {
  return list.map((p) => ({
    key: p.key,
    value: p.value,
    ...(withType ? { type: 'text' } : {}),
    ...(p.enabled ? {} : { disabled: true }),
    ...(p.description ? { description: p.description } : {})
  }))
}

function exportBody(b: RequestBody): Json | undefined {
  switch (b.mode) {
    case 'raw':
      return { mode: 'raw', raw: b.raw, options: { raw: { language: b.rawLanguage } } }
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: exportKv(b.urlencoded, true) }
    case 'formdata':
      return {
        mode: 'formdata',
        formdata: b.formdata.map((f) => ({
          key: f.key,
          ...(f.kind === 'file'
            ? { type: 'file', src: (f.files ?? []).length === 1 ? f.files![0] : (f.files ?? []) }
            : { value: f.value, type: 'text' }),
          ...(f.contentType ? { contentType: f.contentType } : {}),
          ...(f.enabled ? {} : { disabled: true }),
          ...(f.description ? { description: f.description } : {})
        }))
      }
    case 'binary':
      return { mode: 'file', file: { src: b.binaryPath } }
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.graphql.query, variables: b.graphql.variables } }
  }
  return undefined
}

const authParam = (key: string, value: string): Json => ({ key, value, type: 'string' })

function exportAuth(a: Auth): Json | undefined {
  switch (a.type) {
    case 'none':
      return { type: 'noauth' }
    case 'bearer':
      return { type: 'bearer', bearer: [authParam('token', a.bearer?.token ?? '')] }
    case 'basic':
      return {
        type: 'basic',
        basic: [authParam('username', a.basic?.username ?? ''), authParam('password', a.basic?.password ?? '')]
      }
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          authParam('key', a.apikey?.key ?? ''),
          authParam('value', a.apikey?.value ?? ''),
          authParam('in', a.apikey?.in ?? 'header')
        ]
      }
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: [
          authParam('accessToken', a.oauth2?.accessToken ?? ''),
          authParam('headerPrefix', a.oauth2?.headerPrefix ?? 'Bearer'),
          authParam('addTokenTo', 'header')
        ]
      }
  }
  return undefined
}

function exportEvents(s: Scripts): Json[] | undefined {
  const ev: Json[] = []
  if (s.preRequest) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: s.preRequest.split('\n') } })
  if (s.test) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: s.test.split('\n') } })
  return ev.length ? ev : undefined
}

/** Adds the optional keys only when they have a value. */
function withOptional(target: Json, extra: Record<string, unknown>): Json {
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') target[k] = v
  return target
}

function exportItem(it: TreeItem): Json {
  if (it.kind === 'folder') {
    return withOptional(
      { name: it.name, item: it.items.map(exportItem) },
      { description: it.description, auth: exportAuth(it.auth), event: exportEvents(it.scripts) }
    )
  }
  const request = withOptional(
    {
      method: it.method,
      header: exportKv(it.headers, true),
      url: exportUrl(it.url, it.params, it.pathVariables)
    },
    { body: exportBody(it.body), auth: exportAuth(it.auth), description: it.description }
  )
  // Other clients don't know captures: they travel as the test-script lines that do the same.
  const captures = capturesScript(it.captures)
  const scripts = captures ? { ...it.scripts, test: it.scripts.test ? `${it.scripts.test}\n\n${captures}` : captures } : it.scripts
  return withOptional({ name: it.name }, { event: exportEvents(scripts), request, response: [] })
}

/** Converts a collection into Collection v2.1.0 JSON. */
export function exportCollectionV21(c: Collection): object {
  return withOptional(
    {
      info: withOptional({ _postman_id: c.id, name: c.name }, { description: c.description, schema: COLLECTION_SCHEMA_V21 }),
      item: c.items.map(exportItem)
    },
    {
      auth: exportAuth(c.auth),
      event: exportEvents(c.scripts),
      variable: c.variables.length
        ? c.variables.map((v) => ({
            key: v.key,
            value: v.value,
            type: v.secret ? 'secret' : 'string',
            ...(v.enabled ? {} : { disabled: true })
          }))
        : undefined
    }
  )
}

export function exportEnvironmentFile(e: Environment): object {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => ({
      key: v.key,
      value: v.value,
      type: v.secret ? 'secret' : 'default',
      enabled: v.enabled
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'FlosForge Caller'
  }
}
