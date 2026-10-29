import type { Variable } from '../types'

export type VarMap = Record<string, string>

/** Variable scopes, lowest to highest precedence: globals < collection < environment < data < local. */
export interface Scopes {
  globals: VarMap
  collection: VarMap
  environment: VarMap
  /** The current row of a runner data file (CSV/JSON). Empty outside a run. */
  data: VarMap
  local: VarMap
}

export const emptyScopes = (): Scopes => ({ globals: {}, collection: {}, environment: {}, data: {}, local: {} })

export function toMap(vars: Variable[] | undefined): VarMap {
  const out: VarMap = {}
  for (const v of vars ?? []) if (v.enabled && v.key) out[v.key] = v.value
  return out
}

export type VarSource = 'local' | 'data' | 'environment' | 'collection' | 'globals' | 'dynamic'

export function lookup(scopes: Scopes, name: string): { value: string; source: VarSource } | undefined {
  for (const source of ['local', 'data', 'environment', 'collection', 'globals'] as const) {
    if (Object.prototype.hasOwnProperty.call(scopes[source], name)) return { value: scopes[source][name], source }
  }
  if (name.startsWith('$') && dynamicVariables[name]) return { value: dynamicVariables[name](), source: 'dynamic' }
  return undefined
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Replaces {{name}} references; nested references are resolved up to a fixed depth. Unknown names are left as-is. */
export function resolve(text: string, scopes: Scopes): string {
  if (!text || !text.includes('{{')) return text
  let out = text
  for (let depth = 0; depth < 10; depth++) {
    let changed = false
    out = out.replace(VAR_RE, (match, name: string) => {
      const hit = lookup(scopes, name)
      if (hit === undefined) return match
      changed = true
      return hit.value
    })
    if (!changed || !out.includes('{{')) break
  }
  return out
}

export function findVariableRefs(text: string): { name: string; from: number; to: number }[] {
  const refs: { name: string; from: number; to: number }[] = []
  for (const m of text.matchAll(VAR_RE)) refs.push({ name: m[1], from: m.index!, to: m.index! + m[0].length })
  return refs
}

// --- Dynamic variables ({{$guid}} and friends) ---------------------------------

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min
const hex = (n: number): string => Array.from({ length: n }, () => randInt(0, 15).toString(16)).join('')
const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Katherine', 'Dennis', 'Barbara', 'Ken', 'Margaret', 'Tim']
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Johnson', 'Ritchie', 'Liskov', 'Thompson', 'Hamilton', 'Berners-Lee']
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'nova', 'orbit', 'pixel', 'quartz', 'rocket', 'vector', 'zephyr']

export const dynamicVariables: Record<string, () => string> = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randInt(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => pick([...'abcdefghijklmnopqrstuvwxyz0123456789']),
  $randomHexColor: () => `#${hex(6)}`,
  $randomFirstName: () => pick(FIRST),
  $randomLastName: () => pick(LAST),
  $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  $randomUserName: () => `${pick(FIRST).toLowerCase()}${randInt(1, 999)}`,
  $randomEmail: () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}@example.com`,
  $randomWord: () => pick(WORDS),
  $randomWords: () => Array.from({ length: 3 }, () => pick(WORDS)).join(' '),
  $randomIP: () => Array.from({ length: 4 }, () => randInt(1, 254)).join('.'),
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
  $randomColor: () => pick(['red', 'green', 'blue', 'orange', 'purple', 'teal', 'yellow']),
  $randomCity: () => pick(['Athens', 'Lisbon', 'Oslo', 'Kyoto', 'Quito', 'Nairobi', 'Toronto']),
  $randomCountry: () => pick(['Greece', 'Portugal', 'Norway', 'Japan', 'Ecuador', 'Kenya', 'Canada']),
  $randomPhoneNumber: () => `${randInt(200, 999)}-${randInt(200, 999)}-${randInt(1000, 9999)}`,
  $randomLoremSentence: () => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  $randomDateFuture: () => new Date(Date.now() + randInt(1, 365) * 864e5).toISOString(),
  $randomDatePast: () => new Date(Date.now() - randInt(1, 365) * 864e5).toISOString()
}
