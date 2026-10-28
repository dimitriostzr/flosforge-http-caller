import { describe, expect, it } from 'vitest'
import { kv, newCollection, newEnvironment, newFolder, newRequest, variable } from '@shared/model'
import {
  buildVariableReport,
  collectUsages,
  renameInCollection,
  renameInScript,
  renameInText,
  requestVariables,
  scriptVariables,
  winningScope
} from '@shared/variableUsage'

const login = newRequest({
  name: 'Login',
  url: '{{baseUrl}}/login',
  body: { mode: 'raw', raw: '{"user":"{{ user }}"}', rawLanguage: 'json', urlencoded: [], formdata: [], binaryPath: '', graphql: { query: '', variables: '' } },
  scripts: { preRequest: '', test: "pm.environment.set('token', pm.response.json().token)" }
})
const me = newRequest({
  name: 'Me',
  url: '{{baseUrl}}/users/:id',
  pathVariables: [kv('id', '{{userId}}')],
  headers: [kv('X-Trace', '{{$guid}}')],
  params: [kv('debug', '{{debugFlag}}', false)],
  auth: { type: 'bearer', bearer: { token: '{{token}}' } }
})
const folder = newFolder({ name: 'Users', items: [me], scripts: { preRequest: "console.log(pm.variables.get('region'))", test: '' } })
const collection = newCollection({ name: 'API', items: [login, folder], variables: [variable('baseUrl', 'https://api.test'), variable('stale', 'x')] })
const other = newCollection({ name: 'Other', items: [newRequest({ name: 'O', url: '{{otherOnly}}/x' })], variables: [variable('otherOnly', 'y')] })
const dev = newEnvironment({ name: 'Dev', variables: [variable('user', 'ada'), variable('userId', '1'), variable('region', '{{zone}}-1')] })
const prod = newEnvironment({ name: 'Prod', variables: [variable('user', 'grace')] })
const globals = [variable('baseUrl', 'https://global.test'), variable('zone', 'eu')]

describe('variable usage', () => {
  it('reads script calls, old and new API', () => {
    expect(scriptVariables("pm.environment.get('a'); pm.collectionVariables.set(\"b\", 1); postman.setGlobalVariable(`c`, 2); x = '{{d}}'")).toEqual({
      reads: ['a', 'd'],
      sets: ['b', 'c']
    })
  })

  it('finds every use, skipping dynamic variables', () => {
    const uses = collectUsages([collection, other], [dev, prod], globals)
    const where = (name: string) => uses.filter((u) => u.name === name).map((u) => `${u.label}:${u.where}${u.sets ? ':sets' : ''}`)
    expect(where('baseUrl')).toEqual(['Login:url', 'Me:url'])
    expect(where('user')).toEqual(['Login:body'])
    expect(where('token')).toEqual(['Login:script:sets', 'Me:auth'])
    expect(where('userId')).toEqual(['Me:path'])
    expect(where('debugFlag')).toEqual(['Me:params'])
    expect(where('region')).toEqual(['Users:script'])
    expect(where('zone')).toEqual(['Environment “Dev”:value'])
    expect(uses.some((u) => u.name.startsWith('$'))).toBe(false)
  })
})

describe('variable report', () => {
  const rows = buildVariableReport([collection, other], [dev, prod], globals, collection.id)
  const row = (name: string) => rows.find((r) => r.name === name)!

  it('lists definitions per scope and what wins', () => {
    expect(row('baseUrl').collection?.value).toBe('https://api.test')
    expect(row('baseUrl').globals?.value).toBe('https://global.test')
    expect(winningScope(row('baseUrl'), dev.id)).toBe('collection')
    expect(winningScope(row('user'), dev.id)).toBe('environment')
    expect(winningScope(row('user'), null)).toBeNull()
    expect(winningScope(row('zone'), null)).toBe('globals')
  })

  it('flags problems', () => {
    expect(row('debugFlag').undefinedUse).toBe(true)
    // A script sets it, so it isn't undefined.
    expect(row('token')).toMatchObject({ undefinedUse: false, setByScript: true })
    expect(row('userId').missingIn).toEqual([prod.id])
    expect(row('user').missingIn).toEqual([])
    expect(row('stale').unused).toBe(true)
    expect(row('baseUrl').unused).toBe(false)
  })

  it('shows another collection’s own variables only when they are a problem', () => {
    expect(rows.some((r) => r.name === 'otherOnly')).toBe(false)
    const fromOther = buildVariableReport([collection, other], [dev, prod], globals, other.id)
    expect(fromOther.find((r) => r.name === 'otherOnly')?.collection?.value).toBe('y')
    expect(fromOther.find((r) => r.name === 'debugFlag')?.undefinedUse).toBe(true)
  })
})

describe('renaming', () => {
  it('rewrites references, spaces and all', () => {
    expect(renameInText('{{a}} {{ a }} {{ab}} {{a.b}}', 'a', 'z')).toBe('{{z}} {{z}} {{ab}} {{a.b}}')
    expect(renameInText('{{a.b}}', 'a.b', 'c')).toBe('{{c}}')
    expect(renameInScript("pm.environment.get('a'); pm.globals.set(\"a\", 1); pm.environment.get('ab'); '{{a}}'", 'a', 'z')).toBe(
      "pm.environment.get('z'); pm.globals.set(\"z\", 1); pm.environment.get('ab'); '{{z}}'"
    )
  })

  it('renames definitions and every reference in a collection', () => {
    const c = structuredClone(collection)
    renameInCollection(c, 'token', 'accessToken')
    renameInCollection(c, 'baseUrl', 'host')
    const [l, f] = c.items as [typeof login, typeof folder]
    expect(l.url).toBe('{{host}}/login')
    expect(l.scripts.test).toBe("pm.environment.set('accessToken', pm.response.json().token)")
    expect(f.items[0].kind === 'request' && f.items[0].auth.bearer?.token).toBe('{{accessToken}}')
    expect(c.variables.map((v) => v.key)).toEqual(['host', 'stale'])
  })
})

describe('what a request reads', () => {
  it('lists its references in order, with the auth it inherits', () => {
    expect(requestVariables(me)).toEqual(['baseUrl', 'userId', 'debugFlag', 'token'])
    expect(requestVariables(login, { type: 'bearer', bearer: { token: '{{inherited}}' } })).toEqual(['baseUrl', 'user', 'inherited'])
  })
})
