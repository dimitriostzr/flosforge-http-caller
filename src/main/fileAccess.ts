import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Which files requests may upload without asking. A file the user picks in the
// app's file dialog is remembered here. A path that arrived any other way (an
// imported collection, a backup, a pasted cURL command) needs the user's OK in a
// native dialog first, so a shared collection can't quietly upload ~/.ssh/id_rsa.

export class FileAccess {
  private allowed = new Set<string>()
  /** One question per path at a time, even when a run sends it from many requests. */
  private asking = new Map<string, Promise<boolean>>()

  constructor(private readonly file: string) {}

  /** Paths that no longer exist are forgotten, so the list records only files the user still has. */
  async load(): Promise<void> {
    let list: unknown
    try {
      list = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return // No file yet.
    }
    if (!Array.isArray(list)) return
    const paths = list.filter((p): p is string => typeof p === 'string')
    const present = await Promise.all(paths.map((p) => stat(p).then(() => true, () => false)))
    paths.forEach((p, i) => present[i] && this.allowed.add(p))
    if (this.allowed.size !== list.length) await this.save()
  }

  /** Paths the user chose in a file dialog. */
  async allow(paths: string[]): Promise<void> {
    const before = this.allowed.size
    for (const p of paths) this.allowed.add(resolve(p))
    if (this.allowed.size !== before) await this.save()
  }

  /** True when the path may be read: known already, or the user says yes now. */
  async check(path: string, ask: (path: string) => Promise<boolean>): Promise<boolean> {
    const p = resolve(path)
    if (this.allowed.has(p)) return true
    let pending = this.asking.get(p)
    if (!pending) {
      pending = ask(p).finally(() => this.asking.delete(p))
      this.asking.set(p, pending)
    }
    const ok = await pending
    if (ok) await this.allow([p])
    return ok
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify([...this.allowed], null, 2))
    await rename(tmp, this.file)
  }
}
