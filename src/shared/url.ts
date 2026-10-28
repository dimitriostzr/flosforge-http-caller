import { kv } from './model'
import type { KeyValue } from './types'

// URLs typed by the user may contain {{variables}} anywhere, so we never run
// them through `new URL()` until variables are resolved. These helpers work on
// the raw string and keep values exactly as typed (no encoding/decoding).

export interface UrlParts {
  base: string
  query: string
  hash: string
}

export function splitUrl(url: string): UrlParts {
  let rest = url
  let hash = ''
  const h = rest.indexOf('#')
  if (h !== -1) {
    hash = rest.slice(h + 1)
    rest = rest.slice(0, h)
  }
  const q = rest.indexOf('?')
  if (q === -1) return { base: rest, query: '', hash }
  return { base: rest.slice(0, q), query: rest.slice(q + 1), hash }
}

/** Parses a raw query string into params without decoding. */
export function parseQuery(query: string): { key: string; value: string }[] {
  if (!query) return []
  return query
    .split('&')
    .filter((p) => p.length > 0)
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq === -1 ? { key: pair, value: '' } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) }
    })
}

export function buildQuery(params: { key: string; value: string; enabled?: boolean }[]): string {
  return params
    .filter((p) => p.enabled !== false && (p.key !== '' || p.value !== ''))
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&')
}

export function joinUrl({ base, query, hash }: UrlParts): string {
  return base + (query ? `?${query}` : '') + (hash ? `#${hash}` : '')
}

/** Rewrites the query part of `url` from the enabled params. */
export function urlWithParams(url: string, params: KeyValue[]): string {
  const parts = splitUrl(url)
  return joinUrl({ ...parts, query: buildQuery(params) })
}

/**
 * Re-derives the params list after the URL text changed. Enabled params are
 * replaced by what's in the URL (reusing ids/descriptions where keys match so
 * the table doesn't flicker); disabled params are preserved at the end.
 */
export function paramsFromUrl(url: string, previous: KeyValue[]): KeyValue[] {
  const parsed = parseQuery(splitUrl(url).query)
  const pool = previous.filter((p) => p.enabled)
  const next: KeyValue[] = parsed.map(({ key, value }) => {
    const idx = pool.findIndex((p) => p.key === key)
    if (idx !== -1) {
      const [match] = pool.splice(idx, 1)
      return { ...match, key, value }
    }
    return kv(key, value)
  })
  return [...next, ...previous.filter((p) => !p.enabled)]
}

// ---------------------------------------------------------------------------
// Path variables: a path segment written `:name` takes its value from the
// request's path-variable table, like `/users/:id` with id = 42.

/** Start of the path: after `scheme://host[:port]` when there is a scheme, else 0. */
function pathStart(base: string): number {
  const m = /^[a-z][a-z\d+.-]*:\/\/[^/]*/i.exec(base)
  return m ? m[0].length : 0
}

// A segment is `:` then anything up to the next `/`. `{{` is excluded so
// `/:{{x}}` stays a plain variable, and `::` (IPv6 hosts without a scheme) never matches.
const PATH_VAR = /\/:([^/:{}]+)/g

/** Names of the `:name` path segments of `url`, in order, without duplicates. */
export function pathVariableNames(url: string): string[] {
  const { base } = splitUrl(url)
  const path = base.slice(pathStart(base))
  const out: string[] = []
  for (const m of path.matchAll(PATH_VAR)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * The path-variable table for `url`: one row per `:name` segment, in URL order.
 * Rows whose name is still in the URL keep their value, id and description, so
 * editing the URL never loses values that are still in use.
 */
export function pathVariablesFromUrl(url: string, previous: KeyValue[] = []): KeyValue[] {
  return pathVariableNames(url).map((name) => {
    const match = previous.find((p) => p.key === name)
    return match ? { ...match, enabled: true } : kv(name, '')
  })
}

/** Replaces `:name` segments that have a value; the rest stay as typed. */
export function applyPathVariables(url: string, vars: KeyValue[] | undefined): string {
  if (!vars?.length) return url
  const values = new Map(vars.filter((v) => v.key && v.value !== '').map((v) => [v.key, v.value]))
  if (!values.size) return url
  const { base, query, hash } = splitUrl(url)
  const start = pathStart(base)
  const path = base.slice(start).replace(PATH_VAR, (seg, name: string) => (values.has(name) ? `/${values.get(name)}` : seg))
  return joinUrl({ base: base.slice(0, start) + path, query, hash })
}
