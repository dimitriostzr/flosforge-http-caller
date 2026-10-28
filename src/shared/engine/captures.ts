import type { Capture, CaptureScope } from '../types'
import type { Scopes } from './variables'

// Captures: take a value from a response into a variable without a script,
// like `token ← body $.access_token`. They run after the response and before
// the test scripts, in single sends, the runner and the CLI.

export type JsonPath = (string | number)[]

export interface CaptureResponse {
  status: number
  headers: [string, string][]
  /** Decoded body text. */
  body: string
}

export interface CaptureResult {
  variable: string
  scope: CaptureScope
  value?: string
  error?: string
  /** Why it went somewhere else than asked (no active environment, say). */
  note?: string
}

/**
 * Parses `$.data.items[0].id`, `data.items.0.id`, `$['first-name']` or `[-1]`
 * (the last element). `$` alone, or nothing, is the whole document. Null when
 * the path can't be read.
 */
export function parseJsonPath(path: string): JsonPath | null {
  let s = path.trim()
  if (s.startsWith('$')) s = s.slice(1)
  const out: JsonPath = []
  const segment = (raw: string): string | number => (/^-?\d+$/.test(raw) ? Number(raw) : raw)
  let i = 0
  while (i < s.length) {
    if (s[i] === '[') {
      const end = s.indexOf(']', i)
      if (end === -1) return null
      const inner = s.slice(i + 1, end).trim()
      const quoted = /^(['"])(.*)\1$/.exec(inner)
      if (quoted) out.push(quoted[2].replace(/\\(['"\\])/g, '$1'))
      else if (/^-?\d+$/.test(inner)) out.push(Number(inner))
      else return null
      i = end + 1
      continue
    }
    if (s[i] === '.') i++
    let j = i
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++
    const name = s.slice(i, j)
    if (!name) return null
    out.push(segment(name))
    i = j
  }
  return out
}

const IDENT = /^[A-Za-z_$][\w$]*$/

/** The path as `$.data[0]["first-name"]`: what parseJsonPath reads back. */
export function formatJsonPath(path: JsonPath): string {
  return '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : IDENT.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('')
}

function valueAt(root: unknown, path: JsonPath): { found: boolean; value?: unknown } {
  let cur: unknown = root
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return { found: false }
    if (Array.isArray(cur) && typeof seg === 'number') {
      const idx = seg < 0 ? cur.length + seg : seg
      if (idx < 0 || idx >= cur.length) return { found: false }
      cur = cur[idx]
    } else {
      const key = String(seg)
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false }
      cur = (cur as Record<string, unknown>)[key]
    }
  }
  return { found: true, value: cur }
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

function cookieFrom(headers: [string, string][], name: string): string | undefined {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue
    const pair = v.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

/** The value one capture takes from a response, or why it can't. */
export function extractCapture(c: Pick<Capture, 'source' | 'path' | 'regex'>, res: CaptureResponse): { value: string } | { error: string } {
  let text: string
  const path = c.path.trim()
  switch (c.source) {
    case 'status':
      text = String(res.status)
      break
    case 'header': {
      if (!path) return { error: 'No header name' }
      const values = res.headers.filter(([k]) => k.toLowerCase() === path.toLowerCase()).map(([, v]) => v)
      if (!values.length) return { error: `No ${path} header in the response` }
      text = values.join(', ')
      break
    }
    case 'cookie': {
      if (!path) return { error: 'No cookie name' }
      const v = cookieFrom(res.headers, path)
      if (v === undefined) return { error: `The response set no ${path} cookie` }
      text = v
      break
    }
    case 'body': {
      if (!path || path === '$') {
        text = res.body
        break
      }
      const parsed = parseJsonPath(path)
      if (!parsed) return { error: `Can't read the path ${path}` }
      let json: unknown
      try {
        json = JSON.parse(res.body)
      } catch {
        return { error: 'The body isn’t JSON' }
      }
      const hit = valueAt(json, parsed)
      if (!hit.found) return { error: `Nothing at ${path}` }
      text = asText(hit.value)
      break
    }
  }
  if (!c.regex) return { value: text }
  let re: RegExp
  try {
    re = new RegExp(c.regex)
  } catch (e) {
    return { error: `Invalid pattern: ${(e as Error).message}` }
  }
  const m = re.exec(text)
  if (!m) return { error: `The pattern /${c.regex}/ didn’t match` }
  return { value: m[1] ?? m[0] }
}

/**
 * Runs a request's captures into `scopes` (a copy is returned). Without an
 * active environment, or outside a collection, values meant for those scopes
 * stay for the run only.
 */
export function applyCaptures(
  captures: Capture[] | undefined,
  res: CaptureResponse,
  input: Scopes,
  available: { environment: boolean; collection: boolean }
): { results: CaptureResult[]; scopes: Scopes } {
  const scopes = structuredClone(input)
  const results: CaptureResult[] = []
  for (const c of captures ?? []) {
    const variable = c.variable.trim().replace(/^\{\{\s*|\s*\}\}$/g, '')
    if (!c.enabled || !variable) continue
    const got = extractCapture(c, res)
    if ('error' in got) {
      results.push({ variable, scope: c.scope, error: got.error })
      continue
    }
    let scope = c.scope
    let note: string | undefined
    if (scope === 'environment' && !available.environment) {
      scope = 'local'
      note = 'No environment is active, so it’s kept for this run only'
    } else if (scope === 'collection' && !available.collection) {
      scope = 'local'
      note = 'The request isn’t in a collection, so it’s kept for this run only'
    }
    scopes[scope][variable] = got.value
    results.push({ variable, scope, value: got.value, ...(note ? { note } : {}) })
  }
  return { results, scopes }
}

// ---------------------------------------------------------------------------
// As a script, for collection files other clients read

const SETTERS: Record<CaptureScope, string> = {
  environment: 'pm.environment.set',
  collection: 'pm.collectionVariables.set',
  globals: 'pm.globals.set',
  local: 'pm.variables.set'
}

function sourceExpression(c: Capture): string | null {
  const path = c.path.trim()
  switch (c.source) {
    case 'status':
      return 'pm.response.code'
    case 'header':
      return path ? `pm.response.headers.get(${JSON.stringify(path)})` : null
    case 'cookie':
      return path ? `pm.cookies.get(${JSON.stringify(path)})` : null
    case 'body': {
      if (!path || path === '$') return 'pm.response.text()'
      const parsed = parseJsonPath(path)
      if (!parsed) return null
      return 'pm.response.json()' + parsed.map((p) => (typeof p === 'number' && p < 0 ? `.at(${p})` : `[${JSON.stringify(p)}]`)).join('')
    }
  }
}

/** The same captures as test-script lines, so they still work in clients that only run scripts. */
export function capturesScript(captures: Capture[] | undefined): string {
  const lines: string[] = []
  for (const c of captures ?? []) {
    const variable = c.variable.trim()
    const expr = c.enabled && variable ? sourceExpression(c) : null
    if (!expr) continue
    const set = `${SETTERS[c.scope]}(${JSON.stringify(variable)}, `
    if (c.regex) {
      lines.push(
        `try { const m = String(${expr}).match(new RegExp(${JSON.stringify(c.regex)})); if (m) ${set}m[1] ?? m[0]) } catch (e) {}`
      )
    } else {
      lines.push(`try { const v = ${expr}; if (v !== undefined) ${set}typeof v === 'string' ? v : JSON.stringify(v)) } catch (e) {}`)
    }
  }
  return lines.length ? `// Captures (made in FlosForge Caller)\n${lines.join('\n')}` : ''
}

// ---------------------------------------------------------------------------
// Help filling captures in, from a response that came back

export interface JsonEntry {
  path: JsonPath
  value: unknown
}

/** Every value in a JSON document, in document order, up to `limit`. Containers come before their children. */
export function jsonEntries(root: unknown, limit = 500): JsonEntry[] {
  const out: JsonEntry[] = []
  const walk = (value: unknown, path: JsonPath): void => {
    if (out.length >= limit) return
    if (path.length) out.push({ path, value })
    if (value === null || typeof value !== 'object') return
    const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
    for (const [k, v] of entries) walk(v, [...path, k])
  }
  walk(root, [])
  return out
}

/** The variable name a path suggests: its last key, or the key before an index (`items[0]` → items). */
export function nameForPath(path: JsonPath): string {
  const key = [...path].reverse().find((p): p is string => typeof p === 'string') ?? ''
  return key.replace(/[^\w.-]/g, '_')
}

export interface CaptureSuggestion {
  capture: Pick<Capture, 'variable' | 'source' | 'path' | 'regex'>
  /** What it would take, for the chip. */
  preview: string
}

// Keys worth carrying to the next request: tokens, ids, cursors.
const USEFUL_NAME =
  /^(id|uuid|guid|token|jwt|etag|cursor|session|session_?id|(access|refresh|id|auth|csrf|xsrf)_?token|next|next_?(cursor|page|page_?token))$/i
const isUsefulKey = (key: string): boolean =>
  USEFUL_NAME.test(key) || /[a-z\d]Id$/.test(key) || /[a-z\d][_-]id$/i.test(key) || /[a-z\d](Token|_token)$/.test(key)

/** Captures a response suggests, most useful first, at most `max`. */
export function suggestCaptures(res: CaptureResponse, max = 6): CaptureSuggestion[] {
  const out: CaptureSuggestion[] = []
  const seen = new Set<string>()
  const add = (s: CaptureSuggestion): void => {
    if (out.length >= max || seen.has(s.capture.variable)) return
    seen.add(s.capture.variable)
    out.push(s)
  }
  let json: unknown
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  if (json !== undefined) {
    const leaves = jsonEntries(json, 2000).filter((e) => e.value === null || typeof e.value !== 'object')
    // Shallow first: `$.token` beats `$.items[3].owner.id`. Within an array, only its first element.
    const ranked = leaves
      .filter((e) => isUsefulKey(String(e.path[e.path.length - 1])) && !e.path.some((p) => typeof p === 'number' && p > 0))
      .sort((a, b) => a.path.length - b.path.length)
    for (const e of ranked) {
      add({
        capture: { variable: nameForPath(e.path), source: 'body', path: formatJsonPath(e.path), regex: '' },
        preview: asText(e.value)
      })
    }
  }
  const location = res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1]
  if (location) add({ capture: { variable: 'location', source: 'header', path: 'Location', regex: '' }, preview: location })
  for (const [k, v] of res.headers) {
    if (k.toLowerCase() !== 'set-cookie') continue
    const pair = v.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) add({ capture: { variable: pair.slice(0, eq).trim(), source: 'cookie', path: pair.slice(0, eq).trim(), regex: '' }, preview: pair.slice(eq + 1) })
  }
  return out
}
