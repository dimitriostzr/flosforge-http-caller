import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Cookie, CookieJar } from 'tough-cookie'
import type { CookieInfo } from '@shared/types'

const SAVE_DELAY_MS = 300

function createJar(): CookieJar {
  return new CookieJar(null, {
    looseMode: true,
    allowSpecialUseDomain: true,
    allowSecureOnLocal: true,
    // A site can't set cookies for a whole public suffix (evil.github.io for every
    // *.github.io). Intranet hosts keep working: see storeFromResponse.
    rejectPublicSuffixes: true,
    prefixSecurity: 'silent'
  })
}

function isExpired(c: Cookie, now = Date.now()): boolean {
  const exp = c.expiryTime()
  return exp !== undefined && exp <= now
}

function normDomain(domain: string): string {
  return domain.trim().replace(/^\./, '').toLowerCase()
}

function toInfo(c: Cookie): CookieInfo {
  const info: CookieInfo = {
    key: c.key,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    httpOnly: c.httpOnly,
    secure: c.secure
  }
  const exp = c.expiryDate()
  if (exp && !isNaN(exp.getTime())) info.expires = exp.toISOString()
  if (c.sameSite && c.sameSite !== 'none') info.sameSite = c.sameSite
  return info
}

/** Persistent cookie jar backed by a JSON file (in-memory when no path is given). */
export class CookieStore {
  private jar = createJar()
  private timer?: ReturnType<typeof setTimeout>
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly filePath?: string) {}

  async load(): Promise<void> {
    if (!this.filePath) return
    const jar = createJar()
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8')) as { cookies?: unknown[] }
      const now = Date.now()
      for (const raw of Array.isArray(data?.cookies) ? data.cookies : []) {
        const c = Cookie.fromJSON(raw)
        if (c && c.domain && !isExpired(c, now)) await jar.store.putCookie(c)
      }
    } catch {
      // Missing or corrupt file: start with what we have (possibly empty)
    }
    this.jar = jar
  }

  async getCookieHeader(url: string): Promise<string> {
    try {
      return await this.jar.getCookieString(url)
    } catch {
      return ''
    }
  }

  async storeFromResponse(url: string, setCookie: string[]): Promise<void> {
    if (!setCookie.length) return
    for (const header of setCookie) {
      try {
        await this.jar.setCookie(header, url)
      } catch {
        // RFC 6265 §5.3: a Domain that is a public suffix but equals the host itself
        // (Domain=intranet from http://intranet/) makes a host-only cookie instead.
        const host = new URL(url).hostname.toLowerCase()
        const domain = /;\s*domain\s*=\s*\.?([^;\s]+)/i.exec(header)?.[1]?.toLowerCase()
        if (domain === host)
          await this.jar.setCookie(header.replace(/;\s*domain\s*=[^;]*/gi, ''), url, { ignoreError: true }).catch(() => {})
        // Anything else invalid is ignored, cookie by cookie.
      }
    }
    this.scheduleSave()
  }

  async list(): Promise<CookieInfo[]> {
    const now = Date.now()
    const all = (await this.jar.store.getAllCookies()).filter((c) => !isExpired(c, now))
    return all
      .map(toInfo)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.key.localeCompare(b.key) || a.path.localeCompare(b.path))
  }

  async remove(domain: string, path: string, key: string): Promise<void> {
    await this.jar.store.removeCookie(normDomain(domain), path, key)
    this.scheduleSave()
  }

  async removeDomain(domain: string): Promise<void> {
    const d = normDomain(domain)
    for (const c of await this.jar.store.getAllCookies()) {
      if (c.domain === d) await this.jar.store.removeCookie(c.domain, c.path, c.key)
    }
    this.scheduleSave()
  }

  async clear(): Promise<void> {
    await this.jar.removeAllCookies()
    this.scheduleSave()
  }

  /** Adds a cookie as if `url` had sent `Set-Cookie: cookieString`. Throws if it is rejected. */
  async set(url: string, cookieString: string): Promise<void> {
    const c = await this.jar.setCookie(cookieString, url)
    if (!c) throw new Error('Cookie was rejected')
    this.scheduleSave()
  }

  /** Writes pending changes immediately (call on app quit; used by tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      await this.save()
    } else {
      await this.writing
    }
  }

  private scheduleSave(): void {
    if (!this.filePath) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.save()
    }, SAVE_DELAY_MS)
  }

  private save(): Promise<void> {
    this.writing = this.writing
      .then(() => this.writeNow())
      .catch((err) => console.error('Failed to save cookies:', err))
    return this.writing
  }

  private async writeNow(): Promise<void> {
    const file = this.filePath
    if (!file) return
    const data = await this.jar.serialize()
    const tmp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await rename(tmp, file)
  }
}
