// Pure helpers behind the Tree and Table response views.

export type JsonPath = (string | number)[]
export type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

export function typeOf(v: unknown): JsonType {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v as JsonType
}

export const isContainer = (v: unknown): v is Record<string, unknown> | unknown[] =>
  v !== null && typeof v === 'object'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** A JavaScript accessor for scripts, e.g. `pm.response.json().data[0]["first-name"]`. */
export function accessor(path: JsonPath, root = 'pm.response.json()'): string {
  return (
    root +
    path.map((p) => (typeof p === 'number' ? `[${p}]` : IDENT.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('')
  )
}

/** A short label for a path, e.g. `data[0].name`, or `(root)`. */
export function pathLabel(path: JsonPath): string {
  return accessor(path, '').replace(/^\./, '') || '(root)'
}

export function getAt(root: unknown, path: JsonPath): unknown {
  let v = root
  for (const p of path) {
    if (!isContainer(v)) return undefined
    v = (v as Record<string | number, unknown>)[p]
  }
  return v
}

/** One-line preview of a value. Containers show their size instead of their content. */
export function preview(v: unknown, max = 80): string {
  if (Array.isArray(v)) return `[ ${v.length} item${v.length === 1 ? '' : 's'} ]`
  if (isContainer(v)) {
    const n = Object.keys(v).length
    return `{ ${n} key${n === 1 ? '' : 's'} }`
  }
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Text to put on the clipboard for a value: strings unquoted, everything else as JSON. */
export const copyText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

export interface TableModel {
  /** `rows`: an array shown one element per row. `entries`: an object (or a primitive) shown as key/value. */
  kind: 'rows' | 'entries'
  columns: string[]
  rows: { key: string | number; cells: Record<string, unknown> }[]
}

/** The column used when array elements are not objects. */
export const VALUE_COLUMN = 'value'

export function tableFor(v: unknown, maxColumns = 40): TableModel {
  if (Array.isArray(v)) {
    const columns: string[] = []
    const seen = new Set<string>()
    let hasPrimitive = false
    for (const item of v) {
      if (isContainer(item) && !Array.isArray(item)) {
        for (const k of Object.keys(item))
          if (!seen.has(k) && columns.length < maxColumns) {
            seen.add(k)
            columns.push(k)
          }
      } else hasPrimitive = true
    }
    if (hasPrimitive || !columns.length) columns.unshift(VALUE_COLUMN)
    return {
      kind: 'rows',
      columns,
      rows: v.map((item, i) => ({
        key: i,
        cells: isContainer(item) && !Array.isArray(item) ? (item as Record<string, unknown>) : { [VALUE_COLUMN]: item }
      }))
    }
  }
  if (isContainer(v)) {
    return {
      kind: 'entries',
      columns: [VALUE_COLUMN],
      rows: Object.entries(v).map(([key, value]) => ({ key, cells: { [VALUE_COLUMN]: value } }))
    }
  }
  return { kind: 'entries', columns: [VALUE_COLUMN], rows: [{ key: '(value)', cells: { [VALUE_COLUMN]: v } }] }
}

/**
 * Where a table is most useful: the root if it is an array, otherwise the
 * largest array found within a few levels (e.g. `{ data: [...] }`).
 */
export function bestTablePath(root: unknown, maxDepth = 3): JsonPath {
  if (Array.isArray(root) || !isContainer(root)) return []
  let best: { path: JsonPath; size: number } | null = null
  const walk = (v: unknown, path: JsonPath, depth: number): void => {
    if (depth > maxDepth || !isContainer(v)) return
    if (Array.isArray(v)) {
      if (v.length && (!best || v.length > best.size)) best = { path, size: v.length }
      return
    }
    for (const [k, child] of Object.entries(v)) walk(child, [...path, k], depth + 1)
  }
  walk(root, [], 0)
  return (best as { path: JsonPath } | null)?.path ?? []
}

/** Compares two cell values for sorting: numbers numerically, everything else as text; empties last. */
export function compareCells(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return preview(a, 200).localeCompare(preview(b, 200), undefined, { numeric: true })
}
