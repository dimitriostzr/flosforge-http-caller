import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  BootData,
  Collection,
  Environment,
  HistoryEntry,
  SessionState,
  Settings,
  Variable,
  WorkspaceData,
  WorkspaceIndex
} from '@shared/types'

// All user data lives as plain JSON files so it is easy to back up, diff or
// sync:
//
//   data/settings.json            app-wide settings
//   data/workspaces.json          workspace list + which one is open
//   data/cookies.json             cookie jar (app-wide)
//   data/workspaces/<id>/         one folder per workspace:
//       collections/<id>.json     one file per collection
//       environments.json  globals.json  history.json  session.json

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Files that lived directly in data/ before workspaces existed. */
const LEGACY_FILES = ['environments.json', 'globals.json', 'history.json', 'session.json', 'state.json']

export class Store {
  private writeQueue = new Map<string, Promise<void>>()

  constructor(readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'workspaces'), { recursive: true })
    await this.migrateFlatLayout()
  }

  async boot(): Promise<BootData> {
    const index = await this.loadIndex()
    return { index, settings: await this.loadSettings(), data: await this.loadWorkspace(index.activeId) }
  }

  // --- Workspaces ----------------------------------------------------------------

  async loadIndex(): Promise<WorkspaceIndex> {
    const index = await this.readJson<WorkspaceIndex | null>(this.path('workspaces.json'), null)
    if (index && Array.isArray(index.workspaces) && index.workspaces.length) {
      if (!index.workspaces.some((w) => w.id === index.activeId)) index.activeId = index.workspaces[0].id
      return index
    }
    const fresh = this.defaultIndex()
    await this.saveIndex(fresh)
    return fresh
  }

  saveIndex(index: WorkspaceIndex): Promise<void> {
    return this.writeJson(this.path('workspaces.json'), index)
  }

  async loadWorkspace(wsId: string): Promise<WorkspaceData> {
    const dir = this.wsDir(wsId)
    const collectionsDir = join(dir, 'collections')
    await mkdir(collectionsDir, { recursive: true })
    const collections: Collection[] = []
    for (const file of await readdir(collectionsDir)) {
      if (!file.endsWith('.json')) continue
      const c = await this.readJson<Collection | null>(join(collectionsDir, file), null)
      if (c && Array.isArray(c.items)) collections.push(c)
    }
    collections.sort((a, b) => a.createdAt - b.createdAt)
    const session = await this.readJson<Partial<SessionState>>(join(dir, 'session.json'), {})
    return {
      collections,
      environments: await this.readJson<Environment[]>(join(dir, 'environments.json'), []),
      globals: await this.readJson<Variable[]>(join(dir, 'globals.json'), []),
      session: { activeEnvironmentId: null, ...session },
      history: await this.readJson<HistoryEntry[]>(join(dir, 'history.json'), [])
    }
  }

  async deleteWorkspace(wsId: string): Promise<void> {
    await rm(this.wsDir(wsId), { recursive: true, force: true })
  }

  saveCollection(wsId: string, c: Collection): Promise<void> {
    return this.writeJson(this.collectionPath(wsId, c.id), c)
  }

  async deleteCollection(wsId: string, id: string): Promise<void> {
    await rm(this.collectionPath(wsId, id), { force: true })
  }

  saveEnvironments(wsId: string, envs: Environment[]): Promise<void> {
    return this.writeJson(join(this.wsDir(wsId), 'environments.json'), envs)
  }

  saveGlobals(wsId: string, vars: Variable[]): Promise<void> {
    return this.writeJson(join(this.wsDir(wsId), 'globals.json'), vars)
  }

  saveHistory(wsId: string, h: HistoryEntry[]): Promise<void> {
    return this.writeJson(join(this.wsDir(wsId), 'history.json'), h)
  }

  saveSession(wsId: string, session: SessionState): Promise<void> {
    return this.writeJson(join(this.wsDir(wsId), 'session.json'), session)
  }

  // --- Settings --------------------------------------------------------------------

  async loadSettings(): Promise<Settings> {
    const raw = await this.readJson<Partial<Settings> & { theme?: Settings['appearance'] }>(this.path('settings.json'), {})
    // `theme` was the light/dark preference before themes existed.
    const { theme: legacyAppearance, ...rest } = raw
    return {
      ...DEFAULT_SETTINGS,
      ...(legacyAppearance && !rest.appearance ? { appearance: legacyAppearance } : {}),
      ...rest
    }
  }

  saveSettings(s: Settings): Promise<void> {
    return this.writeJson(this.path('settings.json'), s)
  }

  path(name: string): string {
    return join(this.dir, name)
  }

  // --- Internals ---------------------------------------------------------------------

  private defaultIndex(): WorkspaceIndex {
    const id = randomUUID()
    return { workspaces: [{ id, name: 'My Workspace', color: null, createdAt: Date.now() }], activeId: id }
  }

  /** Moves pre-workspace data (collections/ and friends in data/) into a first workspace. */
  private async migrateFlatLayout(): Promise<void> {
    const legacyCollections = this.path('collections')
    const hasLegacy = existsSync(legacyCollections) || LEGACY_FILES.some((f) => existsSync(this.path(f)))
    if (!hasLegacy || existsSync(this.path('workspaces.json'))) return
    const index = this.defaultIndex()
    const target = this.wsDir(index.activeId)
    await mkdir(target, { recursive: true })
    if (existsSync(legacyCollections)) await rename(legacyCollections, join(target, 'collections'))
    for (const f of LEGACY_FILES) {
      if (!existsSync(this.path(f))) continue
      // state.json held only the active environment, which now lives in session.json.
      if (f === 'state.json') await rm(this.path(f), { force: true })
      else await rename(this.path(f), join(target, f))
    }
    await this.saveIndex(index)
  }

  private wsDir(wsId: string): string {
    if (!SAFE_ID.test(wsId)) throw new Error(`Invalid workspace id: ${wsId}`)
    return join(this.dir, 'workspaces', wsId)
  }

  private collectionPath(wsId: string, id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid collection id: ${id}`)
    return join(this.wsDir(wsId), 'collections', `${id}.json`)
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Could not read ${file}:`, err)
        // Keep the unreadable file around instead of overwriting it later.
        await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      }
      return fallback
    }
  }

  /** Atomic write (tmp + rename), serialized per file so writes never interleave. */
  private writeJson(file: string, data: unknown): Promise<void> {
    const prev = this.writeQueue.get(file) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        await mkdir(join(file, '..'), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
        await rename(tmp, file)
      })
    this.writeQueue.set(file, next)
    void next.finally(() => {
      if (this.writeQueue.get(file) === next) this.writeQueue.delete(file)
    })
    return next
  }
}
