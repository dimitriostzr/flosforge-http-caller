import type { ApiRequest, Collection, Folder, TreeItem } from './types'

type Container = Collection | Folder

/** Returns the chain of folders from the collection root down to (excluding) the item, plus the item. */
export function findPath(c: Collection, id: string): { item: TreeItem; parents: Folder[] } | null {
  const walk = (items: TreeItem[], parents: Folder[]): { item: TreeItem; parents: Folder[] } | null => {
    for (const it of items) {
      if (it.id === id) return { item: it, parents }
      if (it.kind === 'folder') {
        const found = walk(it.items, [...parents, it])
        if (found) return found
      }
    }
    return null
  }
  return walk(c.items, [])
}

export function findItem(c: Collection, id: string): TreeItem | null {
  return findPath(c, id)?.item ?? null
}

export function findRequest(c: Collection, id: string): ApiRequest | null {
  const it = findItem(c, id)
  return it?.kind === 'request' ? it : null
}

/** The container holding `id` (the collection itself for top-level items). */
export function findParent(c: Collection, id: string): Container | null {
  const p = findPath(c, id)
  if (!p) return null
  return p.parents.length ? p.parents[p.parents.length - 1] : c
}

export function getContainer(c: Collection, folderId: string | null | undefined): Container | null {
  if (!folderId || folderId === c.id) return c
  const it = findItem(c, folderId)
  return it?.kind === 'folder' ? it : null
}

/** Removes an item anywhere in the tree (mutates). Returns it if found. */
export function removeItem(c: Collection, id: string): TreeItem | null {
  const parent = findParent(c, id)
  if (!parent) return null
  const idx = parent.items.findIndex((i) => i.id === id)
  return parent.items.splice(idx, 1)[0]
}

export function replaceItem(c: Collection, item: TreeItem): boolean {
  const parent = findParent(c, item.id)
  if (!parent) return false
  const idx = parent.items.findIndex((i) => i.id === item.id)
  parent.items[idx] = item
  return true
}

export function isDescendant(folder: Folder, id: string): boolean {
  return folder.items.some((i) => i.id === id || (i.kind === 'folder' && isDescendant(i, id)))
}

export function countRequests(items: TreeItem[]): number {
  return items.reduce((n, i) => n + (i.kind === 'request' ? 1 : countRequests(i.items)), 0)
}

/** All requests in tree order, with their folder chain. Used by the collection runner and search. */
export function flattenRequests(items: TreeItem[], parents: Folder[] = []): { request: ApiRequest; parents: Folder[] }[] {
  return items.flatMap((i) =>
    i.kind === 'request' ? [{ request: i, parents }] : flattenRequests(i.items, [...parents, i])
  )
}
