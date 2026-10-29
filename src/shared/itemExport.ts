import { generateCode } from './codegen'
import { effectiveAuth, prepareRequest } from './engine/prepare'
import { emptyScopes } from './engine/variables'
import { exportCollectionV21, NATIVE_FORMAT_VERSION, type NativeExport } from './importers'
import { newCollection } from './model'
import { findPath } from './tree'
import type { ApiRequest, Collection, Folder } from './types'

// Exporting a single request (or folder) as a file that stands on its own:
// inherited auth is baked in and the collection's variables travel along, so it
// works the same after importing it somewhere else.

export type ItemExportFormat = 'collection' | 'native' | 'curl'

export const ITEM_EXPORT_FORMATS: { id: ItemExportFormat; label: string; menuLabel: string }[] = [
  { id: 'collection', label: 'Collection (v2.1)', menuLabel: 'Collection v2.1: opens here and in other API clients' },
  { id: 'native', label: 'FlosForge Caller file', menuLabel: 'FlosForge Caller file: an exact copy' },
  { id: 'curl', label: 'cURL command', menuLabel: 'cURL command: for a terminal, or paste into a URL bar' }
]

/** The request or folder with "inherit" auth replaced by what it actually inherits. */
function standalone(collection: Collection, item: ApiRequest | Folder): ApiRequest | Folder {
  const copy = structuredClone(item)
  const parents = findPath(collection, item.id)?.parents ?? []
  if (copy.auth.type === 'inherit') {
    copy.auth =
      copy.kind === 'request'
        ? effectiveAuth(copy, parents, collection)
        : effectiveAuth({ ...copy, kind: 'request' } as unknown as ApiRequest, parents, collection)
  }
  return copy
}

export interface ExportedFile {
  fileName: string
  content: string
}

const safe = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'request'

export function exportItem(collection: Collection, item: ApiRequest | Folder, format: ItemExportFormat): ExportedFile {
  const it = standalone(collection, item)
  switch (format) {
    case 'collection': {
      // Collection files hold collections, so the item travels inside one named after it.
      // A folder becomes the collection itself, keeping its auth and scripts.
      const wrapper =
        it.kind === 'folder'
          ? newCollection({ name: it.name, description: it.description, items: it.items, auth: it.auth, scripts: it.scripts, variables: collection.variables })
          : newCollection({ name: it.name, description: it.description, items: [it], auth: { type: 'none' }, variables: collection.variables })
      return { fileName: `${safe(it.name)}.collection.json`, content: JSON.stringify(exportCollectionV21(wrapper), null, 2) }
    }
    case 'native': {
      const data: NativeExport =
        it.kind === 'request'
          ? { flosforgeCaller: NATIVE_FORMAT_VERSION, exportedAt: new Date().toISOString(), collections: [], environments: [], requests: [it] }
          : {
              flosforgeCaller: NATIVE_FORMAT_VERSION,
              exportedAt: new Date().toISOString(),
              collections: [newCollection({ name: it.name, description: it.description, items: it.items, auth: it.auth, scripts: it.scripts, variables: collection.variables })],
              environments: []
            }
      return { fileName: `${safe(it.name)}.ffcaller.json`, content: JSON.stringify(data, null, 2) }
    }
    case 'curl': {
      if (it.kind !== 'request') throw new Error('Only a single request can be exported as cURL')
      // {{variables}} stay as they are: the command is meant to be portable, not to leak values.
      // Basic auth goes in --user rather than a base64 header, so {{user}}:{{pass}} stays readable
      // and imports back as Basic auth.
      const basic = it.auth.type === 'basic' ? it.auth.basic : undefined
      const prepared = prepareRequest(it, basic ? { type: 'none' } : it.auth, emptyScopes())
      let code = generateCode('curl', prepared)
      if (basic) {
        const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
        const [first, ...rest] = code.split('\n')
        const cont = rest.length ? ' \\' : ''
        code = [first.endsWith(' \\') ? first : first + ' \\', `  --user ${quote(`${basic.username}:${basic.password}`)}${cont}`, ...rest].join('\n')
      }
      return { fileName: `${safe(it.name)}.sh`, content: code + '\n' }
    }
  }
}
