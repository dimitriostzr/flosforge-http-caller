import { lookup } from 'node:dns/promises'
import net from 'node:net'
import type { ProxySettings } from '@shared/types'
import { ExecError } from './errors'

// Proxies: which one a URL goes through, and opening a tunnel through it.
// HTTP proxies get plain-http requests in absolute form and a CONNECT tunnel
// for https; SOCKS proxies (4, 4a, 5, 5h) tunnel everything.

export interface ProxyRoute {
  kind: 'http' | 'socks4' | 'socks4a' | 'socks5' | 'socks5h'
  host: string
  port: number
  username: string
  password: string
  /** scheme://host:port, without credentials: safe to show and save. */
  label: string
}

/** Connection milestones, for the response timeline. */
export interface Marks {
  lookup?: number
  connect?: number
  tls?: number
}

const DEFAULT_PORTS: Record<ProxyRoute['kind'], number> = { http: 80, socks4: 1080, socks4a: 1080, socks5: 1080, socks5h: 1080 }

/** Parses `http://user:pass@host:port`, `socks5://host`, or a bare `host:port` (taken as http). */
export function parseProxyUrl(input: string, username = '', password = ''): ProxyRoute {
  let s = input.trim()
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `http://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new ExecError(`Invalid proxy address: ${input}`, 'EPROXY')
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase()
  const kind = (scheme === 'socks' ? 'socks5' : scheme) as ProxyRoute['kind']
  if (!(kind in DEFAULT_PORTS)) {
    throw new ExecError(`Unsupported proxy type: ${scheme} (use http, socks4, socks4a, socks5 or socks5h)`, 'EPROXY')
  }
  if (!u.hostname) throw new ExecError(`Invalid proxy address: ${input}`, 'EPROXY')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = Number(u.port) || DEFAULT_PORTS[kind]
  return {
    kind,
    host,
    port,
    username: username || decodeURIComponent(u.username),
    password: password || decodeURIComponent(u.password),
    label: `${kind}://${net.isIPv6(host) ? `[${host}]` : host}:${port}`
  }
}

// ---------------------------------------------------------------------------
// Bypass lists (NO_PROXY and the custom proxy's exceptions)

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0
}

/**
 * True when `url` should skip the proxy. Entries are comma- or space-separated:
 * `*` (everything), `example.com` (it and its subdomains), `.example.com` or
 * `*.example.com` (the same), `host:port`, `10.0.0.0/8`, and `<local>` (hosts
 * without a dot).
 */
export function bypassesProxy(url: URL, list: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const raw of list.split(/[\s,;]+/)) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    if (entry === '<local>') {
      if (!host.includes('.') && !host.includes(':')) return true
      continue
    }
    const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry)
    if (cidr) {
      if (!net.isIPv4(host)) continue
      const bits = Number(cidr[2])
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      if ((ipv4ToInt(host) & mask) === (ipv4ToInt(cidr[1]) & mask)) return true
      continue
    }
    // host:port, [v6]:port; a bare IPv6 address has several colons and no port
    const withPort = /^\[?([^\]]*?)\]?:(\d+)$/.exec(entry)
    if (withPort && !net.isIPv6(entry)) {
      if (withPort[2] !== port) continue
      entry = withPort[1]
    }
    entry = entry.replace(/^\[|\]$/g, '').replace(/^\*?\./, '')
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Choosing a proxy

type SystemResolver = (url: string) => Promise<string>
let systemResolver: SystemResolver | undefined

/**
 * Lets the app ask the operating system (Electron's session.resolveProxy, which
 * also runs PAC scripts). Without one, "system" means the environment
 * variables, which is what the CLI uses.
 */
export function setSystemProxyResolver(fn: SystemResolver | undefined): void {
  systemResolver = fn
}

/**
 * Picks the first entry of a PAC-style answer (`PROXY a:1; SOCKS5 b:2; DIRECT`)
 * that we can use. In PAC answers plain `SOCKS` means version 4.
 */
export function routeFromPacResult(result: string): ProxyRoute | null {
  let unsupported = ''
  for (const part of result.split(';')) {
    const [type = '', address] = part.trim().split(/\s+/)
    const t = type.toUpperCase()
    if (t === 'DIRECT') return null
    if (!address) continue
    if (t === 'PROXY') return parseProxyUrl(`http://${address}`)
    if (t === 'SOCKS5') return parseProxyUrl(`socks5h://${address}`)
    if (t === 'SOCKS' || t === 'SOCKS4') return parseProxyUrl(`socks4a://${address}`)
    // HTTPS (TLS to the proxy itself) and QUIC aren't supported: try the next entry.
    unsupported ||= part.trim()
  }
  if (unsupported) {
    throw new ExecError(`The system proxy (${unsupported}) is a kind this app can't use. Set a proxy in Settings → Proxy.`, 'EPROXY')
  }
  return null
}

export function routeFromEnv(url: URL, env: NodeJS.ProcessEnv): ProxyRoute | null {
  const get = (name: string): string => env[name.toLowerCase()] || env[name.toUpperCase()] || ''
  const noProxy = get('no_proxy')
  if (noProxy && bypassesProxy(url, noProxy)) return null
  const value = (url.protocol === 'https:' ? get('https_proxy') : get('http_proxy')) || get('all_proxy')
  return value ? parseProxyUrl(value) : null
}

/** The proxy for one request, or null to connect directly. */
export async function proxyFor(url: URL, settings: ProxySettings | undefined): Promise<ProxyRoute | null> {
  if (!settings || settings.mode === 'off') return null
  if (settings.mode === 'custom') {
    if (!settings.url.trim() || bypassesProxy(url, settings.bypass)) return null
    return parseProxyUrl(settings.url, settings.username, settings.password)
  }
  if (systemResolver) {
    let result: string
    try {
      result = await systemResolver(url.href)
    } catch {
      return routeFromEnv(url, process.env)
    }
    return routeFromPacResult(result)
  }
  return routeFromEnv(url, process.env)
}

export function proxyAuthorization(route: ProxyRoute): string | undefined {
  if (!route.username && !route.password) return undefined
  return `Basic ${Buffer.from(`${route.username}:${route.password}`, 'utf8').toString('base64')}`
}

// ---------------------------------------------------------------------------
// Tunnels

/** Reads a proxy's handshake replies off a socket. */
function socketReader(socket: net.Socket) {
  let buf = Buffer.alloc(0)
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const onData = (c: Buffer): void => {
    buf = Buffer.concat([buf, c])
    wake?.()
  }
  const onEnd = (): void => {
    failure ??= new ExecError('The proxy closed the connection', 'EPROXY')
    wake?.()
  }
  const onError = (e: Error): void => {
    failure ??= e
    wake?.()
  }
  socket.on('data', onData)
  socket.on('end', onEnd)
  socket.on('error', onError)
  const wait = async (): Promise<void> => {
    if (failure) throw failure
    await new Promise<void>((r) => (wake = r))
    wake = null
    if (failure) throw failure
  }
  return {
    async take(n: number): Promise<Buffer> {
      while (buf.length < n) await wait()
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
    async takeUntil(delimiter: string, max: number): Promise<Buffer> {
      for (;;) {
        const at = buf.indexOf(delimiter)
        if (at !== -1) {
          const out = buf.subarray(0, at + delimiter.length)
          buf = buf.subarray(at + delimiter.length)
          return out
        }
        if (buf.length > max) throw new ExecError('The proxy sent an invalid response', 'EPROXY')
        await wait()
      }
    },
    /** Hands the socket over: anything read past the handshake goes back on it. */
    release(): void {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('error', onError)
      if (buf.length) socket.unshift(buf)
    }
  }
}

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported'
}

/** For SOCKS proxies that take addresses only. IPv4 first: it's what such proxies most often reach. */
async function resolveIp(host: string, family: 0 | 4): Promise<string> {
  if (net.isIP(host)) return host
  try {
    const all = await lookup(host, { family, all: true })
    return (all.find((a) => a.family === 4) ?? all[0]).address
  } catch (e) {
    throw new ExecError(`Could not resolve host: ${host}`, (e as NodeJS.ErrnoException).code ?? 'ENOTFOUND')
  }
}

function portBytes(port: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(port)
  return b
}

async function socks5Handshake(route: ProxyRoute, r: ReturnType<typeof socketReader>, socket: net.Socket, host: string, port: number): Promise<void> {
  const withAuth = !!(route.username || route.password)
  socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]))
  const [ver, method] = await r.take(2)
  if (ver !== 5) throw new ExecError(`${route.label} is not a SOCKS5 proxy`, 'EPROXY')
  if (method === 2) {
    const user = Buffer.from(route.username, 'utf8')
    const pass = Buffer.from(route.password, 'utf8')
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
    const [, status] = await r.take(2)
    if (status !== 0) throw new ExecError(`The proxy ${route.label} rejected the username or password`, 'EPROXYAUTH')
  } else if (method !== 0) {
    throw new ExecError(
      withAuth ? `The proxy ${route.label} accepts none of our login methods` : `The proxy ${route.label} needs a username and password`,
      'EPROXYAUTH'
    )
  }
  // socks5h: the proxy resolves the name. socks5: we do.
  const target = route.kind === 'socks5' ? await resolveIp(host, 0) : host
  let address: Buffer
  if (net.isIPv4(target)) address = Buffer.from([1, ...target.split('.').map(Number)])
  else if (net.isIPv6(target)) {
    address = Buffer.concat([Buffer.from([4]), Buffer.from(expandIpv6(target).flatMap((g) => [g >> 8, g & 0xff]))])
  } else {
    const name = Buffer.from(target, 'utf8')
    address = Buffer.concat([Buffer.from([3, name.length]), name])
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes(port)]))
  const head = await r.take(5)
  if (head[1] !== 0) {
    throw new ExecError(`The proxy ${route.label} could not connect to ${host}:${port}: ${SOCKS5_ERRORS[head[1]] ?? `error ${head[1]}`}`, 'EPROXY')
  }
  // Bound address: we read past it; its length depends on the type.
  const rest = head[3] === 1 ? 4 + 2 : head[3] === 4 ? 16 + 2 : head[4] + 2
  await r.take(rest - (head[3] === 3 ? 0 : 1))
}

function expandIpv6(address: string): number[] {
  const [left, right = ''] = address.replace(/%.*$/, '').split('::')
  const parse = (s: string): number[] => (s ? s.split(':').map((g) => parseInt(g, 16)) : [])
  const l = parse(left)
  const r = parse(right)
  return address.includes('::') ? [...l, ...Array(8 - l.length - r.length).fill(0), ...r] : l
}

async function socks4Handshake(route: ProxyRoute, r: ReturnType<typeof socketReader>, socket: net.Socket, host: string, port: number): Promise<void> {
  const user = Buffer.from(route.username, 'utf8')
  let ip: Buffer
  let name = Buffer.alloc(0)
  if (route.kind === 'socks4a' && !net.isIPv4(host)) {
    // 0.0.0.x asks the proxy to resolve the name sent after the user id.
    ip = Buffer.from([0, 0, 0, 1])
    name = Buffer.concat([Buffer.from(host, 'utf8'), Buffer.from([0])])
  } else {
    ip = Buffer.from((await resolveIp(host, 4)).split('.').map(Number))
  }
  socket.write(Buffer.concat([Buffer.from([4, 1]), portBytes(port), ip, user, Buffer.from([0]), name]))
  const reply = await r.take(8)
  if (reply[1] !== 0x5a) throw new ExecError(`The proxy ${route.label} refused to connect to ${host}:${port}`, 'EPROXY')
}

async function connectHandshake(route: ProxyRoute, r: ReturnType<typeof socketReader>, socket: net.Socket, host: string, port: number): Promise<void> {
  const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
  const auth = proxyAuthorization(route)
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`
  )
  const head = (await r.takeUntil('\r\n\r\n', 64 * 1024)).toString('latin1')
  const statusLine = head.split('\r\n')[0]
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1])
  if (status === 200) return
  if (status === 407) {
    throw new ExecError(
      auth
        ? `The proxy ${route.label} rejected the username or password (407)`
        : `The proxy ${route.label} needs a username and password (407). Add them in Settings → Proxy.`,
      'EPROXYAUTH'
    )
  }
  throw new ExecError(`The proxy ${route.label} could not open a tunnel to ${authority}: ${statusLine || 'no response'}`, 'EPROXY')
}

/** A TCP stream to `host:port` through the proxy, ready for TLS or plain HTTP. */
export function openTunnel(route: ProxyRoute, host: string, port: number, marks: Marks, signal: AbortSignal): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const socket = net.connect({ host: route.host, port: route.port })
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      socket.off('error', onError)
    }
    const onAbort = (): void => {
      cleanup()
      socket.destroy()
      reject(signal.reason)
    }
    const onError = (e: Error): void => {
      cleanup()
      socket.destroy()
      reject(e)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', onError)
    const t0 = performance.now()
    socket.once('lookup', () => (marks.lookup ??= performance.now()))
    const r = socketReader(socket)
    socket.once('connect', async () => {
      try {
        if (route.kind === 'http') await connectHandshake(route, r, socket, host, port)
        else if (route.kind === 'socks5' || route.kind === 'socks5h') await socks5Handshake(route, r, socket, host, port)
        else await socks4Handshake(route, r, socket, host, port)
        r.release()
        marks.lookup ??= t0
        // "Connect" covers reaching the proxy and the tunnel handshake.
        marks.connect = performance.now()
        cleanup()
        resolve(socket)
      } catch (e) {
        onError(e as Error)
      }
    })
  })
}
