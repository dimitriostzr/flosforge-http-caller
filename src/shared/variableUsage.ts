import { findVariableRefs } from './engine/variables'
import type { ApiRequest, Auth, Collection, Environment, Flow, FlowCondition, Folder, Scripts, TreeItem, Variable } from './types'

// Where variables are used, and renaming one everywhere. Used requests are
// found by their {{references}}; scripts also by the names they pass to
// pm.environment.get/set and friends, so a variable a login script sets
// counts as defined.

export type UsageWhere = 'url' | 'params' | 'path' | 'headers' | 'body' | 'auth' | 'script' | 'capture' | 'value' | 'flow'

export interface VariableUsage {
  name: string
  where: UsageWhere
  /** A script sets it (pm.environment.set('name', …)) rather than reading it. */
  sets?: boolean
  collectionId?: string
  /** The request, folder or collection it's in; absent for values of other variables. */
  itemId?: string
  itemKind?: 'request' | 'folder' | 'collection' | 'flow'
  /** The request's name, or where the variable value is ("Environment “Dev”"). */
  label: string
}

export const USAGE_LABELS: Record<UsageWhere, string> = {
  url: 'URL',
  params: 'Params',
  path: 'Path variables',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth',
  script: 'Script',
  capture: 'Capture',
  value: 'Value',
  flow: 'Flow step'
}

// pm.environment.get('x'), pm.collectionVariables.set("x", …), environment.has(`x`), …
const SCRIPT_CALL =
  /\b((?:pm\.(?:environment|collectionVariables|globals|variables|iterationData)|environment|globals)\.(get|set|unset|has)\(\s*)(['"`])([^'"`\n]+)\3/g
// The older API: postman.setEnvironmentVariable('x', …), postman.getGlobalVariable('x')
const LEGACY_CALL = /\b(postman\.(set|get|clear)(?:Environment|Global)Variable\(\s*)(['"`])([^'"`\n]+)\3/g

/** Variable names a script reads and sets. */
export function scriptVariables(code: string): { reads: string[]; sets: string[] } {
  const reads = new Set<string>()
  const sets = new Set<string>()
  for (const re of [SCRIPT_CALL, LEGACY_CALL]) {
    for (const m of code.matchAll(re)) (m[2] === 'set' ? sets : reads).add(m[4])
  }
  for (const r of findVariableRefs(code)) reads.add(r.name.trim())
  return { reads: [...reads], sets: [...sets] }
}

const isDynamic = (name: string): boolean => name.startsWith('$')

function textRefs(text: string | undefined): string[] {
  return text ? findVariableRefs(text).map((r) => r.name.trim()).filter((n) => n && !isDynamic(n)) : []
}

function authTexts(auth: Auth): string[] {
  switch (auth.type) {
    case 'bearer':
      return [auth.bearer?.token ?? '']
    case 'basic':
      return [auth.basic?.username ?? '', auth.basic?.password ?? '']
    case 'apikey':
      return [auth.apikey?.key ?? '', auth.apikey?.value ?? '']
    case 'oauth2':
      return [auth.oauth2?.accessToken ?? '', auth.oauth2?.headerPrefix ?? '']
    default:
      return []
  }
}

/** The texts of a request, by where they are. Only the body mode in use counts. */
function requestTexts(r: ApiRequest): [UsageWhere, string][] {
  const out: [UsageWhere, string][] = [['url', r.url]]
  for (const v of r.pathVariables ?? []) out.push(['path', v.value])
  // Enabled params are already in the URL.
  for (const p of r.params) if (!p.enabled) out.push(['params', p.key], ['params', p.value])
  for (const h of r.headers) out.push(['headers', h.key], ['headers', h.value])
  const b = r.body
  if (b.mode === 'raw') out.push(['body', b.raw])
  if (b.mode === 'urlencoded') for (const f of b.urlencoded) out.push(['body', f.key], ['body', f.value])
  if (b.mode === 'formdata') for (const f of b.formdata) out.push(['body', f.key], ['body', f.kind === 'text' ? f.value : ''])
  if (b.mode === 'graphql') out.push(['body', b.graphql.query], ['body', b.graphql.variables])
  for (const t of authTexts(r.auth)) out.push(['auth', t])
  return out
}

/** Every use of every variable in the workspace. */
export function collectUsages(
  collections: Collection[],
  environments: Environment[],
  globals: Variable[],
  flows: Flow[] = []
): VariableUsage[] {
  const out: VariableUsage[] = []
  const seen = new Set<string>()
  const add = (u: VariableUsage): void => {
    const key = `${u.name}\0${u.where}\0${u.itemId ?? u.label}\0${u.sets ? 1 : 0}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(u)
  }
  const fromScripts = (scripts: Scripts, base: Omit<VariableUsage, 'name' | 'where'>): void => {
    for (const code of [scripts.preRequest, scripts.test]) {
      const { reads, sets } = scriptVariables(code)
      for (const name of reads) add({ ...base, name, where: 'script' })
      for (const name of sets) add({ ...base, name, where: 'script', sets: true })
    }
  }
  const fromValues = (vars: Variable[], label: string, collectionId?: string): void => {
    for (const v of vars) for (const name of textRefs(v.value)) add({ name, where: 'value', label, collectionId })
  }

  for (const c of collections) {
    const container = (it: Collection | Folder, kind: 'collection' | 'folder'): void => {
      const base = { collectionId: c.id, itemId: it.id, itemKind: kind, label: it.name }
      for (const t of authTexts(it.auth)) for (const name of textRefs(t)) add({ ...base, name, where: 'auth' })
      fromScripts(it.scripts, base)
    }
    const walk = (items: TreeItem[]): void => {
      for (const it of items) {
        if (it.kind === 'folder') {
          container(it, 'folder')
          walk(it.items)
          continue
        }
        const base = { collectionId: c.id, itemId: it.id, itemKind: 'request' as const, label: it.name }
        for (const [where, text] of requestTexts(it)) for (const name of textRefs(text)) add({ ...base, name, where })
        fromScripts(it.scripts, base)
        for (const c of it.captures ?? []) if (c.enabled && c.variable.trim()) add({ ...base, name: c.variable.trim(), where: 'capture', sets: true })
      }
    }
    container(c, 'collection')
    walk(c.items)
    fromValues(c.variables, `Collection “${c.name}”`, c.id)
  }
  for (const e of environments) fromValues(e.variables, `Environment “${e.name}”`)
  fromValues(globals, 'Globals')
  for (const f of flows) {
    f.steps.forEach((st, i) => {
      const base = { itemId: f.id, itemKind: 'flow' as const, label: `${f.name} · step ${i + 1}`, where: 'flow' as const }
      for (const v of st.variables ?? []) {
        if (v.key.trim()) add({ ...base, name: v.key.trim(), sets: true })
        for (const name of textRefs(v.value)) add({ ...base, name })
      }
      for (const c of st.captures ?? []) if (c.enabled && c.variable.trim()) add({ ...base, name: c.variable.trim(), sets: true })
      for (const cond of [st.runIf, st.expect, st.repeatUntil?.condition]) {
        if (!cond) continue
        if (cond.source === 'variable' && cond.path.trim()) add({ ...base, name: cond.path.trim().replace(/^\{\{\s*|\s*\}\}$/g, '') })
        for (const name of textRefs(cond.value)) add({ ...base, name })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Renaming

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rewrites {{from}} (spaces inside the braces allowed) as {{to}}. */
export function renameInText(text: string, from: string, to: string): string {
  if (!text || !text.includes('{{')) return text
  return text.replace(new RegExp(`\\{\\{\\s*${escape(from)}\\s*\\}\\}`, 'g'), `{{${to}}}`)
}

/** {{from}} references plus the names given to pm.environment.get('from') and friends. */
export function renameInScript(code: string, from: string, to: string): string {
  const swap = (m: string, head: string, _op: string, quote: string, name: string): string =>
    name === from ? `${head}${quote}${to}${quote}` : m
  return renameInText(code, from, to).replace(SCRIPT_CALL, swap).replace(LEGACY_CALL, swap)
}

function renameAuth(auth: Auth, from: string, to: string): void {
  const r = (s: string): string => renameInText(s, from, to)
  if (auth.bearer) auth.bearer.token = r(auth.bearer.token)
  if (auth.basic) Object.assign(auth.basic, { username: r(auth.basic.username), password: r(auth.basic.password) })
  if (auth.apikey) Object.assign(auth.apikey, { key: r(auth.apikey.key), value: r(auth.apikey.value) })
  if (auth.oauth2) Object.assign(auth.oauth2, { accessToken: r(auth.oauth2.accessToken), headerPrefix: r(auth.oauth2.headerPrefix) })
}

function renameScripts(scripts: Scripts, from: string, to: string): void {
  scripts.preRequest = renameInScript(scripts.preRequest, from, to)
  scripts.test = renameInScript(scripts.test, from, to)
}

/** Renames references in a request, in place. Every body mode, not just the one in use. */
export function renameInRequest(req: ApiRequest, from: string, to: string): void {
  const r = (s: string): string => renameInText(s, from, to)
  req.url = r(req.url)
  for (const list of [req.params, req.headers, req.body.urlencoded, req.body.formdata, req.pathVariables ?? []])
    for (const kv of list) Object.assign(kv, { key: r(kv.key), value: r(kv.value) })
  req.body.raw = r(req.body.raw)
  req.body.graphql = { query: r(req.body.graphql.query), variables: r(req.body.graphql.variables) }
  renameAuth(req.auth, from, to)
  renameScripts(req.scripts, from, to)
  for (const c of req.captures ?? []) if (c.variable.trim() === from) c.variable = to
}

/** Renames the variable's definitions and references in a list of variables, in place. */
export function renameInVariables(vars: Variable[], from: string, to: string): void {
  for (const v of vars) {
    if (v.key === from) v.key = to
    v.value = renameInText(v.value, from, to)
  }
}

function renameInCondition(c: FlowCondition | undefined, from: string, to: string): void {
  if (!c) return
  if (c.source === 'variable' && c.path.trim().replace(/^\{\{\s*|\s*\}\}$/g, '') === from) c.path = to
  c.value = renameInText(c.value, from, to)
}

/** Renames a variable in a flow's step values, captures and conditions, in place. */
export function renameInFlow(f: Flow, from: string, to: string): void {
  for (const st of f.steps) {
    for (const v of st.variables ?? []) Object.assign(v, { key: v.key === from ? to : v.key, value: renameInText(v.value, from, to) })
    for (const c of st.captures ?? []) if (c.variable.trim() === from) c.variable = to
    renameInCondition(st.runIf, from, to)
    renameInCondition(st.expect, from, to)
    renameInCondition(st.repeatUntil?.condition, from, to)
  }
}

/** Renames definitions and references in a collection, in place. */
export function renameInCollection(c: Collection, from: string, to: string): void {
  renameInVariables(c.variables, from, to)
  const container = (it: Collection | Folder): void => {
    renameAuth(it.auth, from, to)
    renameScripts(it.scripts, from, to)
    for (const child of it.items) {
      if (child.kind === 'folder') container(child)
      else renameInRequest(child, from, to)
    }
  }
  container(c)
}

// ---------------------------------------------------------------------------
// The workspace's variables in one table

export interface VariableRow {
  name: string
  globals?: Variable
  /** In the collection the table is showing. */
  collection?: Variable
  /** By environment id. */
  environments: Record<string, Variable | undefined>
  /** Every use, in any collection. */
  usages: VariableUsage[]
  /** A script or capture sets it, so it can have a value at run time without being defined. */
  setByScript: boolean
  /** Used somewhere it can get no value from: no scope it could come from defines it and no script sets it. */
  undefinedUse: boolean
  /** Defined, but nothing uses it. */
  unused: boolean
  /** Environments without it while others have it (ids). */
  missingIn: string[]
}

const findVar = (vars: Variable[] | undefined, name: string): Variable | undefined =>
  vars?.find((v) => v.key === name && v.enabled) ?? vars?.find((v) => v.key === name)

/**
 * One row per variable name: its definitions, uses and problems. Rows cover
 * globals, environments and `collectionId`'s variables, the names used in that
 * collection, and anything used but undefined anywhere. Problems are judged
 * across all collections, each use against its own collection's variables.
 */
export function buildVariableReport(
  collections: Collection[],
  environments: Environment[],
  globals: Variable[],
  collectionId: string | null,
  flows: Flow[] = []
): VariableRow[] {
  const usages = collectUsages(collections, environments, globals, flows)
  const byName = new Map<string, VariableUsage[]>()
  for (const u of usages) byName.set(u.name, [...(byName.get(u.name) ?? []), u])
  const setByScript = new Set(usages.filter((u) => u.sets).map((u) => u.name))
  const defined = (vars: Variable[], name: string): boolean => vars.some((v) => v.key === name && v.enabled)
  const collectionsById = new Map(collections.map((c) => [c.id, c]))
  const shown = collectionsById.get(collectionId ?? '')

  const isUndefinedUse = (name: string): boolean => {
    if (setByScript.has(name) || defined(globals, name) || environments.some((e) => defined(e.variables, name))) return false
    return (byName.get(name) ?? []).some((u) => {
      if (u.sets) return false
      const own = u.collectionId ? collectionsById.get(u.collectionId) : undefined
      return !own || !defined(own.variables, name)
    })
  }

  const names = new Set<string>()
  for (const v of globals) if (v.key) names.add(v.key)
  for (const e of environments) for (const v of e.variables) if (v.key) names.add(v.key)
  for (const v of shown?.variables ?? []) if (v.key) names.add(v.key)
  for (const u of usages) if (!u.collectionId || u.collectionId === shown?.id || isUndefinedUse(u.name)) names.add(u.name)

  return [...names]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((name) => {
      const envs = Object.fromEntries(environments.map((e) => [e.id, findVar(e.variables, name)]))
      const inEnvs = environments.filter((e) => envs[e.id])
      const definedSomewhere =
        !!findVar(globals, name) || inEnvs.length > 0 || collections.some((c) => !!findVar(c.variables, name))
      const used = (byName.get(name) ?? []).length > 0
      return {
        name,
        globals: findVar(globals, name),
        collection: findVar(shown?.variables, name),
        environments: envs,
        usages: byName.get(name) ?? [],
        setByScript: setByScript.has(name),
        undefinedUse: isUndefinedUse(name),
        unused: definedSomewhere && !used,
        missingIn: inEnvs.length && environments.length > 1 ? environments.filter((e) => !envs[e.id]).map((e) => e.id) : []
      }
    })
}

/** Which definition a request in the shown collection uses, with `activeEnvironmentId` active. */
export function winningScope(row: VariableRow, activeEnvironmentId: string | null): 'environment' | 'collection' | 'globals' | null {
  if (activeEnvironmentId && row.environments[activeEnvironmentId]?.enabled) return 'environment'
  if (row.collection?.enabled) return 'collection'
  if (row.globals?.enabled) return 'globals'
  return null
}

/**
 * The variables a request reads when it's sent, in order: {{references}} in its
 * URL, params, path variables, headers, body (the mode in use) and auth. Pass
 * the auth it inherits when it has none of its own.
 */
export function requestVariables(req: ApiRequest, auth: Auth = req.auth): string[] {
  const names = new Set<string>()
  for (const [, text] of requestTexts({ ...req, auth })) for (const n of textRefs(text)) names.add(n)
  return [...names]
}
