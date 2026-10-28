import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, session, shell, systemPreferences } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type {
  Appearance,
  Collection,
  Environment,
  ExecOptions,
  Flow,
  ExecProgress,
  HistoryEntry,
  OpenedFile,
  PreparedRequest,
  SessionState,
  Settings,
  Variable,
  WorkspaceIndex
} from '@shared/types'
import { APP_NAME, APP_SLUG, TITLEBAR_HEIGHT } from '@shared/app'
import { CookieStore } from './cookies'
import { executeRequest, setUserAgent } from './http'
import { setSystemProxyResolver } from './proxy'
import { Store } from './store'
import icon from '../../resources/icon.png?asset'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

// FLOSFORGE_CALLER_DATA_DIR lets you run a portable copy or keep dev data separate.
// (DISPATCH_DATA_DIR is the pre-rename name, still honoured.)
const dataDirOverride = process.env['FLOSFORGE_CALLER_DATA_DIR'] || process.env['DISPATCH_DATA_DIR']
app.setName(APP_NAME)
const dataDir = dataDirOverride || join(app.getPath('userData'), 'data')
const store = new Store(dataDir)
const cookies = new CookieStore(join(dataDir, 'cookies.json'))
const inflight = new Map<string, AbortController>()
let mainWindow: BrowserWindow | null = null
/** Set once the user asks to quit (Cmd+Q, menu, OS logout), so closing the window finishes the quit. */
let quitting = false

// Production UI is served from app://caller/ rather than file:// so it has a
// real origin and per-file CSP headers. The script sandbox worker gets its own
// policy: eval is allowed (user scripts run via new Function) but all network
// access is blocked, so scripts can only reach the network via pm.sendRequest.
const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-src 'self' blob: data:; object-src 'none'; base-uri 'none'"
const WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'"

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
])

function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url)
    const file = normalize(join(root, decodeURIComponent(pathname)))
    if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', /\/assets\/sandbox[^/]*\.js$/.test(pathname) ? WORKER_CSP : PAGE_CSP)
    return new Response(res.body, { status: res.status, headers })
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f3f4f7',
    icon,
    // The app draws its own title bar in the theme's colours. On macOS the traffic
    // lights sit inside it (the UI leaves room for them); on Windows and Linux the
    // OS controls are drawn over its right end and recoloured with the theme.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: Math.round((TITLEBAR_HEIGHT - 16) / 2) } }
      : {
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#111318' : '#f3f4f7',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e3e6ee' : '#1a1e28',
            height: TITLEBAR_HEIGHT
          }
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Give the renderer a chance to write debounced changes before closing.
  // Preventing the close also cancels a quit in progress, so if the user was
  // quitting, quit again once the flush is done (or the app stays running on macOS).
  let flushed = false
  const win = mainWindow
  win.on('close', (e) => {
    if (flushed) return
    e.preventDefault()
    const done = (): void => {
      if (flushed) return
      flushed = true
      clearTimeout(timer)
      ipcMain.removeListener('app:flushed', done)
      if (quitting) app.quit()
      else if (!win.isDestroyed()) win.close()
    }
    const timer = setTimeout(done, 2000)
    ipcMain.once('app:flushed', done)
    win.webContents.send('app:flush')
  })
  // On macOS the app outlives its window; menu commands must not reach a destroyed one.
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Links open in the user's browser; the app window never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault()
  })

  if (isDev) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    void mainWindow.loadURL('app://caller/index.html')
  }
}

function sendMenu(command: string): void {
  mainWindow?.webContents.send('menu', command)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-request') },
        { label: 'New Collection', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new-collection') },
        { label: 'New Workspace…', click: () => sendMenu('new-workspace') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('import') },
        { type: 'separator' },
        { label: 'Save Request', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenu('close-tab') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { label: 'Open Data Folder', click: () => void shell.openPath(dataDir) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('toggle-sidebar') },
        { label: 'Toggle Layout', accelerator: 'CmdOrCtrl+Alt+L', click: () => sendMenu('toggle-layout') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev || process.env['FLOSFORGE_CALLER_DEVTOOLS'] ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }] : [])
      ]
    },
    {
      label: 'Request',
      submenu: [
        { label: 'Send', accelerator: 'CmdOrCtrl+Enter', click: () => sendMenu('send') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => sendMenu('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendMenu('prev-tab') }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    dataDir
  }))
  ipcMain.handle('app:openDataDir', () => shell.openPath(dataDir))
  // Electron ships the licenses of Chromium, Node.js and their libraries; packaging copies them into resources.
  ipcMain.handle('app:openRuntimeLicenses', () =>
    shell.openPath(
      app.isPackaged
        ? join(process.resourcesPath, 'LICENSES.chromium.html')
        : join(app.getAppPath(), 'node_modules/electron/dist/LICENSES.chromium.html')
    )
  )
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
  })
  // Native chrome (title bar, scrollbars, dialogs) follows the resolved scheme.
  ipcMain.handle('app:setScheme', (_e, scheme: Appearance) => {
    nativeTheme.themeSource = scheme
  })
  /** The OS accent colour as #RRGGBB, or null where the platform has none (Linux). */
  ipcMain.handle('app:systemAccent', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return null
    try {
      return `#${systemPreferences.getAccentColor().slice(0, 6)}`
    } catch {
      return null
    }
  })

  // Keep the OS window controls in the theme's colours (Windows/Linux overlay only).
  ipcMain.handle('app:titleBarColors', (_e, color: string, symbolColor: string) => {
    if (process.platform !== 'darwin' && mainWindow && !mainWindow.isDestroyed())
      mainWindow.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT })
  })
  // With the native title bar hidden there is no menu bar on Windows/Linux; the
  // title bar's menu button pops the same application menu instead.
  ipcMain.handle('app:popupMenu', (_e, x: number, y: number) => {
    if (mainWindow) Menu.getApplicationMenu()?.popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) })
  })

  ipcMain.handle('app:boot', () => store.boot())
  ipcMain.handle('settings:save', (_e, s: Settings) => store.saveSettings(s))
  ipcMain.handle('workspaces:save', (_e, index: WorkspaceIndex) => store.saveIndex(index))
  ipcMain.handle('workspace:load', (_e, wsId: string) => store.loadWorkspace(wsId))
  ipcMain.handle('workspace:delete', (_e, wsId: string) => store.deleteWorkspace(wsId))
  ipcMain.handle('collection:save', (_e, wsId: string, c: Collection) => store.saveCollection(wsId, c))
  ipcMain.handle('collection:delete', (_e, wsId: string, id: string) => store.deleteCollection(wsId, id))
  ipcMain.handle('environments:save', (_e, wsId: string, envs: Environment[]) => store.saveEnvironments(wsId, envs))
  ipcMain.handle('globals:save', (_e, wsId: string, vars: Variable[]) => store.saveGlobals(wsId, vars))
  ipcMain.handle('history:save', (_e, wsId: string, h: HistoryEntry[]) => store.saveHistory(wsId, h))
  ipcMain.handle('flows:save', (_e, wsId: string, flows: Flow[]) => store.saveFlows(wsId, flows))
  ipcMain.handle('session:save', (_e, wsId: string, s: SessionState) => store.saveSession(wsId, s))

  // With `live`, the response is also reported while it arrives (as http:progress).
  ipcMain.handle('http:send', async (e, req: PreparedRequest, opts: ExecOptions, live?: boolean) => {
    const controller = new AbortController()
    inflight.set(req.execId, controller)
    const onProgress = live
      ? (p: ExecProgress) => {
          if (!e.sender.isDestroyed()) e.sender.send('http:progress', req.execId, p)
        }
      : undefined
    try {
      return await executeRequest(req, opts, controller.signal, cookies, onProgress)
    } finally {
      inflight.delete(req.execId)
    }
  })
  ipcMain.handle('http:cancel', (_e, execId: string) => {
    inflight.get(execId)?.abort()
  })

  ipcMain.handle('cookies:list', () => cookies.list())
  ipcMain.handle('cookies:remove', (_e, domain: string, path: string, key: string) => cookies.remove(domain, path, key))
  ipcMain.handle('cookies:removeDomain', (_e, domain: string) => cookies.removeDomain(domain))
  ipcMain.handle('cookies:clear', () => cookies.clear())
  ipcMain.handle('cookies:set', (_e, url: string, cookie: string) => cookies.set(url, cookie))

  ipcMain.handle('dialog:openFiles', async (_e, title: string): Promise<OpenedFile[]> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Collections & environments', extensions: ['json', 'txt', 'sh'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled) return []
    return Promise.all(
      res.filePaths.map(async (path) => ({ name: basename(path), path, content: await readFile(path, 'utf8') }))
    )
  })
  ipcMain.handle('dialog:pickFile', async (_e, multi: boolean) => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile']
    })
    return res.canceled ? [] : res.filePaths
  })
  // Reports as PDF: Chromium's own print engine, in a hidden window that runs no scripts.
  ipcMain.handle('export:renderPdf', async (_e, html: string) => {
    const dir = await mkdtemp(join(tmpdir(), 'ffcaller-pdf-'))
    const file = join(dir, 'report.html')
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
    try {
      await writeFile(file, html, 'utf8')
      await win.loadFile(file)
      const pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
      })
      return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength)
    } finally {
      win.destroy()
      await rm(dir, { recursive: true, force: true })
    }
  })
  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, data: string | Uint8Array) => {
    const res = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName })
    if (res.canceled || !res.filePath) return false
    await writeFile(res.filePath, data)
    return true
  })
}

/** The app was called "Dispatch" before; carry its data over on first launch under the new name. */
async function migrateLegacyDataDir(): Promise<void> {
  if (dataDirOverride || existsSync(dataDir)) return
  const legacy = join(app.getPath('appData'), 'Dispatch', 'data')
  if (!existsSync(legacy)) return
  await cp(legacy, dataDir, { recursive: true })
  console.log(`Copied data from ${legacy}`)
}

app.whenReady().then(async () => {
  registerAppProtocol()
  await migrateLegacyDataDir().catch((e) => console.error('Data migration failed', e))
  await store.init()
  await cookies.load()
  setUserAgent(`${APP_SLUG}/${app.getVersion()}`)
  // "Use the system proxy" asks the OS (and runs PAC scripts), the way the browser does.
  setSystemProxyResolver((url) => session.defaultSession.resolveProxy(url))
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  void cookies.flush()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
