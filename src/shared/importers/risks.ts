import type { ApiRequest, Scripts, TreeItem } from '../types'
import type { ImportResult } from './index'

/** What an import brings that acts on the user's computer: scripts and file uploads. */
export interface ImportRisks {
  /** Non-empty pre-request and test scripts, at any level. */
  scripts: number
  /** File paths in form fields and binary bodies. */
  files: string[]
}

const scriptCount = (s: Scripts | undefined): number => (s?.preRequest?.trim() ? 1 : 0) + (s?.test?.trim() ? 1 : 0)

function requestFiles(r: ApiRequest): string[] {
  const b = r.body
  return [...(b.binaryPath ? [b.binaryPath] : []), ...b.formdata.filter((f) => f.kind === 'file').flatMap((f) => f.files ?? [])]
}

export function importRisks(results: ImportResult[]): ImportRisks {
  let scripts = 0
  const files = new Set<string>()
  const walk = (items: TreeItem[]): void => {
    for (const item of items) {
      scripts += scriptCount(item.scripts)
      if (item.kind === 'folder') walk(item.items)
      else requestFiles(item).forEach((f) => files.add(f))
    }
  }
  for (const r of results) {
    for (const c of r.collections) {
      scripts += scriptCount(c.scripts)
      walk(c.items)
    }
    if (r.request) {
      scripts += scriptCount(r.request.scripts)
      requestFiles(r.request).forEach((f) => files.add(f))
    }
  }
  return { scripts, files: [...files] }
}
