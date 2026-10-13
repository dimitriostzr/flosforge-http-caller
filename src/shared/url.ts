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
