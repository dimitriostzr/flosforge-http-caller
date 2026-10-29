// Runs inside the CLI's QuickJS interpreter, before the sandbox. QuickJS has
// the language but none of a browser worker's globals, so this adds the ones
// the sandbox and everyday scripts use, each backed by a narrow host function.
// Nothing else from the host is reachable: no process, require, files or sockets.

interface Host {
  post(json: string): void
  timer(id: number, ms: number): void
  clearTimer(id: number): void
  /** `n` random bytes as hex. */
  randomBytes(n: number): string
  /** WHATWG URL parts as JSON; throws on an invalid URL. */
  parseUrl(input: string, base: string | null): string
}

const g = globalThis as unknown as Record<string, unknown>
const host = g.__host as Host
delete g.__host

// --- Worker messaging ----------------------------------------------------------------

g.self = globalThis
g.postMessage = (msg: unknown): void => host.post(JSON.stringify(msg))

const noop = (): void => {}
g.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop, table: noop, dir: noop }

// Everything the sandbox exchanges is JSON data.
g.structuredClone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
g.queueMicrotask = (fn: () => void): void => void Promise.resolve().then(fn)

// --- Events (chai announces plugins with them) -----------------------------------------------

class EventShim {
  readonly type: string
  defaultPrevented = false
  constructor(type: string) {
    this.type = String(type)
  }
  preventDefault(): void {
    this.defaultPrevented = true
  }
}
type Listener = ((e: EventShim) => void) | { handleEvent(e: EventShim): void }
class EventTargetShim {
  private listeners = new Map<string, Listener[]>()
  addEventListener(type: string, fn: Listener | null): void {
    if (!fn) return
    const list = this.listeners.get(type) ?? []
    if (!list.includes(fn)) list.push(fn)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, fn: Listener | null): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn))
  }
  dispatchEvent(e: EventShim): boolean {
    for (const l of [...(this.listeners.get(e.type) ?? [])]) typeof l === 'function' ? l.call(this, e) : l.handleEvent(e)
    return !e.defaultPrevented
  }
}
g.Event = EventShim
g.EventTarget = EventTargetShim

// --- Timers ----------------------------------------------------------------------------

const timers = new Map<number, { fn: () => void; repeat?: number }>()
let nextTimer = 1
const addTimer = (fn: unknown, ms: unknown, repeat: boolean, args: unknown[]): number => {
  const id = nextTimer++
  const delay = Math.max(0, Number(ms) || 0)
  if (typeof fn !== 'function') return id
  timers.set(id, { fn: () => (fn as (...a: unknown[]) => void)(...args), repeat: repeat ? Math.max(1, delay) : undefined })
  host.timer(id, delay)
  return id
}
const clearTimer = (id: unknown): void => {
  if (timers.delete(Number(id))) host.clearTimer(Number(id))
}
g.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => addTimer(fn, ms, false, args)
g.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => addTimer(fn, ms, true, args)
g.clearTimeout = clearTimer
g.clearInterval = clearTimer

// --- crypto ----------------------------------------------------------------------------

const randomBytes = (n: number): number[] => (host.randomBytes(n).match(/../g) ?? []).map((h) => parseInt(h, 16))
g.crypto = {
  getRandomValues<T extends ArrayBufferView>(arr: T): T {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    bytes.set(randomBytes(bytes.length))
    return arr
  },
  randomUUID(): string {
    const b = randomBytes(16)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = b.map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}

// --- Text encoding and base64 ------------------------------------------------------------

class TextEncoderShim {
  readonly encoding = 'utf-8'
  encode(input = ''): Uint8Array {
    const s = unescape(encodeURIComponent(String(input).replace(/[\ud800-\udfff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')))
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }
}

class TextDecoderShim {
  readonly encoding = 'utf-8'
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return ''
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    let out = ''
    for (let i = 0; i < bytes.length; ) {
      const b = bytes[i]
      const len = b < 0x80 ? 1 : b >= 0xf0 && b < 0xf8 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b < 0xe0 ? 2 : 0
      let cp = len === 1 ? b : len === 2 ? b & 0x1f : len === 3 ? b & 0x0f : b & 0x07
      let ok = len > 0 && i + len <= bytes.length
      for (let j = 1; ok && j < len; j++) {
        const c = bytes[i + j]
        if ((c & 0xc0) !== 0x80) ok = false
        else cp = (cp << 6) | (c & 0x3f)
      }
      if (ok && ((len === 3 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (len === 4 && (cp < 0x10000 || cp > 0x10ffff)))) ok = false
      if (!ok) {
        out += '�'
        i++
        continue
      }
      out += String.fromCodePoint(cp)
      i += len
    }
    return out
  }
}
g.TextEncoder = TextEncoderShim
g.TextDecoder = TextDecoderShim

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
g.btoa = (input: unknown): string => {
  const s = String(input)
  if (/[^\x00-\xff]/.test(s)) throw new Error('btoa: the string contains characters outside of the Latin1 range')
  let out = ''
  for (let i = 0; i < s.length; i += 3) {
    const [a, b, c] = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)]
    const n = (a << 16) | ((b || 0) << 8) | (c || 0)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=')
  }
  return out
}
g.atob = (input: unknown): string => {
  const s = String(input).replace(/[\t\n\f\r ]/g, '')
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]/.test(s)) throw new Error('atob: the string is not correctly encoded')
  let out = ''
  let bits = 0
  let value = 0
  for (const ch of s.replace(/=+$/, '')) {
    value = (value << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((value >> bits) & 0xff)
    }
  }
  return out
}

// --- URL and URLSearchParams ---------------------------------------------------------------

const formEncode = (s: string): string => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const formDecode = (s: string): string => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

class URLSearchParamsShim {
  private list: [string, string][] = []
  /** Set by a URL to keep its search in step. */
  onChange?: (search: string) => void

  constructor(init?: unknown) {
    if (typeof init === 'string') this.parse(init)
    else if (init instanceof URLSearchParamsShim) this.list = init.list.map(([k, v]) => [k, v])
    else if (Array.isArray(init)) this.list = init.map(([k, v]) => [String(k), String(v)])
    else if (init && typeof init === 'object') this.list = Object.entries(init).map(([k, v]) => [k, String(v)])
  }
  parse(s: string): void {
    this.list = s
      .replace(/^\?/, '')
      .split('&')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=')
        return i === -1 ? [formDecode(p), ''] : [formDecode(p.slice(0, i)), formDecode(p.slice(i + 1))]
      })
  }
  private changed(): void {
    this.onChange?.(this.toString())
  }
  get size(): number {
    return this.list.length
  }
  append(k: string, v: string): void {
    this.list.push([String(k), String(v)])
    this.changed()
  }
  delete(k: string, v?: string): void {
    this.list = this.list.filter(([a, b]) => a !== String(k) || (v !== undefined && b !== String(v)))
    this.changed()
  }
  get(k: string): string | null {
    return this.list.find(([a]) => a === String(k))?.[1] ?? null
  }
  getAll(k: string): string[] {
    return this.list.filter(([a]) => a === String(k)).map(([, b]) => b)
  }
  has(k: string, v?: string): boolean {
    return this.list.some(([a, b]) => a === String(k) && (v === undefined || b === String(v)))
  }
  set(k: string, v: string): void {
    const key = String(k)
    const i = this.list.findIndex(([a]) => a === key)
    if (i === -1) this.list.push([key, String(v)])
    else this.list = [...this.list.slice(0, i), [key, String(v)], ...this.list.slice(i + 1).filter(([a]) => a !== key)]
    this.changed()
  }
  sort(): void {
    this.list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    this.changed()
  }
  forEach(fn: (v: string, k: string, p: URLSearchParamsShim) => void): void {
    this.list.forEach(([k, v]) => fn(v, k, this))
  }
  keys(): IterableIterator<string> {
    return this.list.map(([k]) => k)[Symbol.iterator]()
  }
  values(): IterableIterator<string> {
    return this.list.map(([, v]) => v)[Symbol.iterator]()
  }
  entries(): IterableIterator<[string, string]> {
    return this.list.map(([k, v]) => [k, v] as [string, string])[Symbol.iterator]()
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }
  toString(): string {
    return this.list.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join('&')
  }
}

interface UrlParts {
  href: string
  protocol: string
  username: string
  password: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  origin: string
}

const parse = (input: string, base?: string): UrlParts => {
  try {
    return JSON.parse(host.parseUrl(input, base ?? null)) as UrlParts
  } catch {
    throw new TypeError(`Invalid URL: ${input}`)
  }
}

class URLShim {
  private parts: UrlParts
  readonly searchParams: URLSearchParamsShim

  constructor(input: unknown, base?: unknown) {
    this.parts = parse(String(input), base === undefined ? undefined : String(base))
    this.searchParams = new URLSearchParamsShim(this.parts.search)
    this.searchParams.onChange = (q) => this.update({ search: q ? `?${q}` : '' }, false)
  }
  static canParse(input: unknown, base?: unknown): boolean {
    try {
      parse(String(input), base === undefined ? undefined : String(base))
      return true
    } catch {
      return false
    }
  }
  /** Rebuilds the URL with some parts replaced, through the host's parser. */
  private update(change: Partial<UrlParts>, syncParams = true): void {
    const p = { ...this.parts, ...change }
    const auth = p.username || p.password ? `${p.username}${p.password ? `:${p.password}` : ''}@` : ''
    const href = 'href' in change ? change.href! : `${p.protocol}//${auth}${'hostname' in change || 'port' in change ? `${p.hostname}${p.port ? `:${p.port}` : ''}` : p.host}${p.pathname}${p.search}${p.hash}`
    this.parts = parse(href)
    if (syncParams) this.searchParams.parse(this.parts.search)
  }
  get href(): string {
    return this.parts.href
  }
  set href(v: string) {
    this.update({ href: String(v) })
  }
  get origin(): string {
    return this.parts.origin
  }
  get protocol(): string {
    return this.parts.protocol
  }
  set protocol(v: string) {
    this.update({ protocol: String(v).replace(/:?$/, ':') })
  }
  get username(): string {
    return this.parts.username
  }
  set username(v: string) {
    this.update({ username: encodeURIComponent(String(v)) })
  }
  get password(): string {
    return this.parts.password
  }
  set password(v: string) {
    this.update({ password: encodeURIComponent(String(v)) })
  }
  get host(): string {
    return this.parts.host
  }
  set host(v: string) {
    this.update({ host: String(v) })
  }
  get hostname(): string {
    return this.parts.hostname
  }
  set hostname(v: string) {
    this.update({ hostname: String(v) })
  }
  get port(): string {
    return this.parts.port
  }
  set port(v: string) {
    this.update({ port: String(v) })
  }
  get pathname(): string {
    return this.parts.pathname
  }
  set pathname(v: string) {
    const s = String(v)
    this.update({ pathname: s.startsWith('/') ? s : `/${s}` })
  }
  get search(): string {
    return this.parts.search
  }
  set search(v: string) {
    const s = String(v)
    this.update({ search: s && !s.startsWith('?') ? `?${s}` : s === '?' ? '' : s })
  }
  get hash(): string {
    return this.parts.hash
  }
  set hash(v: string) {
    const s = String(v)
    this.update({ hash: s && !s.startsWith('#') ? `#${s}` : s === '#' ? '' : s })
  }
  toString(): string {
    return this.parts.href
  }
  toJSON(): string {
    return this.parts.href
  }
}
g.URL = URLShim
g.URLSearchParams = URLSearchParamsShim

// --- Entry points for the host ---------------------------------------------------------------

g.__guest = {
  deliver(json: string): void {
    const onmessage = g.onmessage as ((e: { data: unknown }) => void) | undefined
    onmessage?.({ data: JSON.parse(json) })
  },
  fire(id: number): void {
    const t = timers.get(id)
    if (!t) return
    if (t.repeat !== undefined) host.timer(id, t.repeat)
    else timers.delete(id)
    t.fn()
  }
}
