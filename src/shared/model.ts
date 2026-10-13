import type {
  ApiRequest,
  Auth,
  Collection,
  Environment,
  Folder,
  FormField,
  KeyValue,
  RequestBody,
  Scripts,
  TreeItem,
  Variable
} from './types'

export const uid = (): string => globalThis.crypto.randomUUID()

export const kv = (key = '', value = '', enabled = true, description?: string): KeyValue => ({
  id: uid(),
  key,
  value,
  enabled,
  ...(description ? { description } : {})
})

export const variable = (key = '', value = '', enabled = true, secret = false): Variable => ({
  ...kv(key, value, enabled),
  ...(secret ? { secret } : {})
})

export const formField = (key = '', value = '', kind: FormField['kind'] = 'text'): FormField => ({
  ...kv(key, value),
  kind
})

export const emptyBody = (): RequestBody => ({
  mode: 'none',
  raw: '',
  rawLanguage: 'json',
  urlencoded: [],
  formdata: [],
  binaryPath: '',
  graphql: { query: '', variables: '' }
})

export const emptyScripts = (): Scripts => ({ preRequest: '', test: '' })

export const inheritAuth = (): Auth => ({ type: 'inherit' })
export const noAuth = (): Auth => ({ type: 'none' })

export const newRequest = (partial: Partial<ApiRequest> = {}): ApiRequest => ({
  kind: 'request',
  id: uid(),
  name: 'New request',
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  body: emptyBody(),
  auth: inheritAuth(),
  scripts: emptyScripts(),
  description: '',
  ...partial
})

export const newFolder = (partial: Partial<Folder> = {}): Folder => ({
  kind: 'folder',
  id: uid(),
  name: 'New folder',
  items: [],
  auth: inheritAuth(),
  scripts: emptyScripts(),
  description: '',
  ...partial
})

export const newCollection = (partial: Partial<Collection> = {}): Collection => {
  const now = Date.now()
  return {
    id: uid(),
    name: 'New collection',
    items: [],
    auth: noAuth(),
    scripts: emptyScripts(),
    variables: [],
    description: '',
    createdAt: now,
    updatedAt: now,
    ...partial
  }
}

export const newEnvironment = (partial: Partial<Environment> = {}): Environment => ({
  id: uid(),
  name: 'New environment',
  variables: [],
  ...partial
})

/** Deep-copies a tree item, giving it and all descendants fresh ids. */
export function cloneWithNewIds<T extends TreeItem>(item: T): T {
  const copy = structuredClone(item)
  const walk = (it: TreeItem): void => {
    it.id = uid()
    if (it.kind === 'folder') it.items.forEach(walk)
  }
  walk(copy)
  return copy
}
