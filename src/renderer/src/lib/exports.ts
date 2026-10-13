import { REPORT_FORMATS, resultReport, runReport, toCsv, type ReportFormat } from '@shared/engine/exports'
import { toJUnit, toJsonReport } from '@shared/engine/report'
import { exportItem, type ItemExportFormat } from '@shared/itemExport'
import { findItem } from '@shared/tree'
import { newCollection } from '@shared/model'
import { useWorkspace } from '../store/workspace'
import { useRuntime } from '../store/runtime'
import { toast } from '../store/dialogs'
import { runTarget } from './collectionRunner'
import { safeFileName } from './format'

// Everything that can be downloaded: response and run reports, table views, and
// requests or folders as importable files.

const stamp = (t: number): string => new Date(t).toISOString().slice(0, 19).replace(/[:T]/g, '-')

async function save(fileName: string, data: string | Uint8Array, what: string): Promise<void> {
  try {
    if (await window.api.saveFile(fileName, data)) toast(`${what} saved`, 'success')
  } catch (e) {
    toast(`Could not save: ${(e as Error).message}`, 'error')
  }
}

const extFor = (format: ReportFormat): string => REPORT_FORMATS.find((f) => f.id === format)!.ext

/** The last response of a request tab, as a report. */
export async function exportResult(tabId: string, format: ReportFormat): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  const run = useRuntime.getState().results[tabId]
  if (tab?.kind !== 'request' || !run?.prepared) return
  const input = {
    name: tab.draft.name,
    at: run.at,
    request: run.prepared,
    response: run.result?.ok ? run.result.response : undefined,
    error: run.error ?? (run.result && !run.result.ok ? run.result.error.message : undefined),
    tests: run.tests,
    logs: run.logs
  }
  const base = `${safeFileName(tab.draft.name)}-${stamp(run.at)}`
  const data = format === 'pdf' ? await window.api.renderPdf(resultReport(input, 'html')) : resultReport(input, format)
  await save(`${base}.${extFor(format)}`, data, 'Report')
}

/** A runner tab's results. `junit` is offered here too, for CI tooling. */
export async function exportRun(tabId: string, format: ReportFormat | 'junit'): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  const run = useRuntime.getState().runs[tabId]
  if (tab?.kind !== 'runner' || !run?.summary) return
  const name = runTarget(tab)?.name ?? 'run'
  const base = `${safeFileName(name)}-run-${stamp(run.startedAt)}`
  let data: string | Uint8Array
  let ext: string
  if (format === 'junit') [data, ext] = [toJUnit(name, run.summary, run.steps), 'junit.xml']
  else if (format === 'json') [data, ext] = [JSON.stringify(toJsonReport(name, run.summary, run.steps), null, 2), 'json']
  else if (format === 'pdf') [data, ext] = [await window.api.renderPdf(runReport(name, run.summary, run.steps, 'html')), 'pdf']
  else [data, ext] = [runReport(name, run.summary, run.steps, format), extFor(format)]
  await save(`${base}.${ext}`, data, 'Report')
}

/** Rows exactly as shown in a table view (filtered and sorted). */
export async function exportTableCsv(fileBase: string, columns: string[], rows: unknown[][]): Promise<void> {
  await save(`${safeFileName(fileBase)}.csv`, toCsv([columns, ...rows]), 'CSV')
}

/** A request or folder as a file that imports into this app (and, in v2.1 format, into other API clients). */
export async function exportTreeItem(collectionId: string, itemId: string, format: ItemExportFormat): Promise<void> {
  const collection = useWorkspace.getState().collections.find((c) => c.id === collectionId)
  const item = collection && findItem(collection, itemId)
  if (!collection || !item) return
  try {
    const file = exportItem(collection, item, format)
    await save(file.fileName, file.content, item.kind === 'request' ? 'Request' : 'Folder')
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}

/** The request open in a tab, as shown (unsaved edits included); works for unsaved requests too. */
export async function exportRequestTab(tabId: string, format: ItemExportFormat): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  if (tab?.kind !== 'request') return
  const collection =
    (tab.collectionId && useWorkspace.getState().collections.find((c) => c.id === tab.collectionId)) ||
    // A request that isn't in a collection: give it a throwaway one so inheritance has nothing to find.
    newCollection({ name: tab.draft.name, items: [tab.draft] })
  try {
    const file = exportItem(collection, tab.draft, format)
    await save(file.fileName, file.content, 'Request')
  } catch (e) {
    toast((e as Error).message, 'error')
  }
}
