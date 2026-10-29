import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { newCollection, newEnvironment } from '@shared/model'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'ffcaller-store-'))

describe('Store', () => {
  it('creates one default workspace on a fresh install', async () => {
    const store = new Store(tempDir())
    await store.init()
    const boot = await store.boot()
    expect(boot.index.workspaces).toHaveLength(1)
    expect(boot.index.workspaces[0]).toMatchObject({ name: 'My Workspace', color: null })
    expect(boot.index.activeId).toBe(boot.index.workspaces[0].id)
    expect(boot.data.collections).toEqual([])
    expect(boot.settings.themeId).toBe('flosforge')
  })

  it('moves the pre-workspace flat layout into a first workspace', async () => {
    const dir = tempDir()
    const c = newCollection({ name: 'Legacy API' })
    mkdirSync(join(dir, 'collections'))
    writeFileSync(join(dir, 'collections', `${c.id}.json`), JSON.stringify(c))
    writeFileSync(join(dir, 'environments.json'), JSON.stringify([newEnvironment({ name: 'Prod' })]))
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ activeEnvironmentId: null, tabs: [] }))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ activeEnvironmentId: null }))
    // `theme` was the light/dark preference before themes existed.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', timeoutMs: 1234 }))

    const store = new Store(dir)
    await store.init()
    const boot = await store.boot()
    expect(boot.data.collections.map((x) => x.name)).toEqual(['Legacy API'])
    expect(boot.data.environments.map((x) => x.name)).toEqual(['Prod'])
    expect(boot.settings).toMatchObject({ appearance: 'dark', timeoutMs: 1234, themeId: 'flosforge' })
    expect(existsSync(join(dir, 'collections'))).toBe(false)
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
    expect(existsSync(join(dir, 'workspaces', boot.index.activeId, 'collections', `${c.id}.json`))).toBe(true)

    // Running init again must not migrate twice or lose anything.
    await new Store(dir).init()
    expect((await new Store(dir).boot()).data.collections).toHaveLength(1)
  })

  it('keeps workspaces separate and deletes one cleanly', async () => {
    const dir = tempDir()
    const store = new Store(dir)
    await store.init()
    const { index } = await store.boot()
    const a = index.activeId
    const b = 'second-ws'
    await store.saveIndex({ workspaces: [...index.workspaces, { id: b, name: 'Two', color: '#E05C5C', createdAt: 1 }], activeId: b })
    await store.saveCollection(a, newCollection({ name: 'Only in A' }))
    await store.saveCollection(b, newCollection({ name: 'Only in B' }))
    await store.saveHistory(b, [])

    expect((await store.loadWorkspace(a)).collections.map((x) => x.name)).toEqual(['Only in A'])
    expect((await store.loadWorkspace(b)).collections.map((x) => x.name)).toEqual(['Only in B'])
    const reloaded = await new Store(dir).boot()
    expect(reloaded.index.activeId).toBe(b)
    expect(reloaded.data.collections.map((x) => x.name)).toEqual(['Only in B'])

    await store.deleteWorkspace(b)
    expect(existsSync(join(dir, 'workspaces', b))).toBe(false)
    expect((await store.loadWorkspace(a)).collections).toHaveLength(1)
  })

  it('falls back to the first workspace when the active id is unknown', async () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ id: 'w1', name: 'One', color: null, createdAt: 0 }], activeId: 'gone' })
    )
    const store = new Store(dir)
    await store.init()
    expect((await store.boot()).index.activeId).toBe('w1')
  })

  it('rejects ids that could escape the data folder', async () => {
    const store = new Store(tempDir())
    await store.init()
    await expect(store.loadWorkspace('../../etc')).rejects.toThrow(/Invalid workspace id/)
    expect(() => store.saveCollection('ok', { ...newCollection(), id: '../x' })).toThrow(/Invalid collection id/)
  })

  it('writes readable JSON', async () => {
    const dir = tempDir()
    const store = new Store(dir)
    await store.init()
    const { index } = await store.boot()
    expect(JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8')).activeId).toBe(index.activeId)
  })
})
