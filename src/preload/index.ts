import { contextBridge, ipcRenderer } from 'electron'
import type {
  Appearance,
  BootData,
  Collection,
  CookieInfo,
  Environment,
  ExecOptions,
  ExecResult,
  HistoryEntry,
  OpenedFile,
  PreparedRequest,
  SessionState,
  Settings,
  Variable,
  WorkspaceData,
  WorkspaceIndex
} from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api = {
  /** Synchronous so the first render can lay out the title bar for the right OS. */
  platform: process.platform,
  setTitleBarColors: (color: string, symbolColor: string): Promise<void> => invoke('app:titleBarColors', color, symbolColor),
  popupAppMenu: (x: number, y: number): Promise<void> => invoke('app:popupMenu', x, y),
  info: (): Promise<{ name: string; version: string; platform: string; dataDir: string }> => invoke('app:info'),
  openDataDir: (): Promise<void> => invoke('app:openDataDir'),
  openExternal: (url: string): Promise<void> => invoke('app:openExternal', url),
  /** Opens the Chromium/Node.js/Electron license file in the default browser. */
  openRuntimeLicenses: (): Promise<string> => invoke('app:openRuntimeLicenses'),
  setScheme: (scheme: Appearance): Promise<void> => invoke('app:setScheme', scheme),
  systemAccent: (): Promise<string | null> => invoke('app:systemAccent'),

  boot: (): Promise<BootData> => invoke('app:boot'),
  saveSettings: (s: Settings): Promise<void> => invoke('settings:save', s),
  saveWorkspaces: (index: WorkspaceIndex): Promise<void> => invoke('workspaces:save', index),
  loadWorkspace: (wsId: string): Promise<WorkspaceData> => invoke('workspace:load', wsId),
  deleteWorkspace: (wsId: string): Promise<void> => invoke('workspace:delete', wsId),

  // Everything below is stored inside a workspace, named by its id.
  saveCollection: (wsId: string, c: Collection): Promise<void> => invoke('collection:save', wsId, c),
  deleteCollection: (wsId: string, id: string): Promise<void> => invoke('collection:delete', wsId, id),
  saveEnvironments: (wsId: string, envs: Environment[]): Promise<void> => invoke('environments:save', wsId, envs),
  saveGlobals: (wsId: string, vars: Variable[]): Promise<void> => invoke('globals:save', wsId, vars),
  saveHistory: (wsId: string, h: HistoryEntry[]): Promise<void> => invoke('history:save', wsId, h),
  saveSession: (wsId: string, s: SessionState): Promise<void> => invoke('session:save', wsId, s),

  send: (req: PreparedRequest, opts: ExecOptions): Promise<ExecResult> => invoke('http:send', req, opts),
  cancel: (execId: string): Promise<void> => invoke('http:cancel', execId),

  cookies: {
    list: (): Promise<CookieInfo[]> => invoke('cookies:list'),
    remove: (domain: string, path: string, key: string): Promise<void> => invoke('cookies:remove', domain, path, key),
    removeDomain: (domain: string): Promise<void> => invoke('cookies:removeDomain', domain),
    clear: (): Promise<void> => invoke('cookies:clear'),
    set: (url: string, cookie: string): Promise<void> => invoke('cookies:set', url, cookie)
  },

  openFiles: (title: string): Promise<OpenedFile[]> => invoke('dialog:openFiles', title),
  pickFiles: (multi = false): Promise<string[]> => invoke('dialog:pickFile', multi),
  /** Renders a standalone HTML document to PDF bytes. */
  renderPdf: (html: string): Promise<Uint8Array> => invoke('export:renderPdf', html),
  saveFile: (defaultName: string, data: string | Uint8Array): Promise<boolean> =>
    invoke('dialog:saveFile', defaultName, data),

  /** Main asks the renderer to write pending changes before the window closes. */
  onFlushRequest: (flush: () => Promise<unknown>): (() => void) => {
    const listener = (): void => {
      void flush().finally(() => ipcRenderer.send('app:flushed'))
    }
    ipcRenderer.on('app:flush', listener)
    return () => ipcRenderer.removeListener('app:flush', listener)
  },

  onMenu: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, command: string): void => cb(command)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
