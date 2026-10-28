import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_CERTIFICATES,
  type CertificateSettings,
  type ExecOptions,
  type ExecProgress,
  type ExecResult,
  type HttpResponse,
  type PreparedRequest,
  type ProxySettings
} from '@shared/types'
import { executeRequest } from '../src/main/http'
import { bypassesProxy, parseProxyUrl, routeFromEnv, routeFromPacResult } from '../src/main/proxy'
import { hostMatches } from '../src/main/certificates'

// Proxies, certificates and live (streamed) responses, against local servers.

const opts: ExecOptions = { timeoutMs: 5000, followRedirects: true, maxRedirects: 10, verifySsl: true, useCookieJar: false }
let n = 0
const prep = (url: string, method = 'GET'): PreparedRequest => ({ execId: String(++n), method, url, headers: [], body: { type: 'none' } })
const ok = (r: ExecResult): HttpResponse => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.response
}
const text = (r: HttpResponse): string => Buffer.from(r.body).toString('utf8')
// Tunnels detach sockets from their server, so track them to close everything at the end.
const open = new WeakMap<net.Server, Set<net.Socket>>()
const listen = (s: net.Server): Promise<number> => {
  const sockets = new Set<net.Socket>()
  open.set(s, sockets)
  s.on('connection', (c: net.Socket) => {
    sockets.add(c)
    c.on('close', () => sockets.delete(c))
  })
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)))
}
const close = (s: net.Server): Promise<void> =>
  new Promise((r) => {
    for (const c of open.get(s) ?? []) c.destroy()
    s.close(() => r())
  })

// ---------------------------------------------------------------------------
// Pure helpers

describe('proxy settings', () => {
  it('parses proxy addresses', () => {
    expect(parseProxyUrl('proxy.local:3128')).toMatchObject({ kind: 'http', host: 'proxy.local', port: 3128, label: 'http://proxy.local:3128' })
    expect(parseProxyUrl('http://u%40x:p%3Aw@p:8080')).toMatchObject({ username: 'u@x', password: 'p:w', label: 'http://p:8080' })
    expect(parseProxyUrl('socks://h')).toMatchObject({ kind: 'socks5', port: 1080 })
    expect(parseProxyUrl('socks5h://[::1]:9050')).toMatchObject({ kind: 'socks5h', host: '::1', label: 'socks5h://[::1]:9050' })
    expect(parseProxyUrl('http://a:b@p', 'override', 'pw')).toMatchObject({ username: 'override', password: 'pw' })
    expect(() => parseProxyUrl('https://p:443')).toThrow(/Unsupported proxy type: https/)
  })

  it('matches bypass lists', () => {
    const u = (s: string): URL => new URL(s)
    expect(bypassesProxy(u('http://localhost:3000/'), 'localhost')).toBe(true)
    expect(bypassesProxy(u('http://api.example.com/'), 'example.com')).toBe(true)
    expect(bypassesProxy(u('http://api.example.com/'), '.example.com')).toBe(true)
    expect(bypassesProxy(u('http://api.example.com/'), '*.example.com')).toBe(true)
    expect(bypassesProxy(u('http://notexample.com/'), 'example.com')).toBe(false)
    expect(bypassesProxy(u('http://h.test:8080/'), 'h.test:8080')).toBe(true)
    expect(bypassesProxy(u('http://h.test:8081/'), 'h.test:8080')).toBe(false)
    expect(bypassesProxy(u('https://h.test/'), 'h.test:443')).toBe(true)
    expect(bypassesProxy(u('http://10.1.2.3/'), '10.0.0.0/8')).toBe(true)
    expect(bypassesProxy(u('http://11.1.2.3/'), '10.0.0.0/8')).toBe(false)
    expect(bypassesProxy(u('http://[::1]:80/'), '::1')).toBe(true)
    expect(bypassesProxy(u('http://intranet/'), '<local>')).toBe(true)
    expect(bypassesProxy(u('http://a.b/'), '<local>')).toBe(false)
    expect(bypassesProxy(u('http://anything/'), 'x.test, *')).toBe(true)
  })

  it('reads PAC answers and environment variables', () => {
    expect(routeFromPacResult('DIRECT')).toBeNull()
    expect(routeFromPacResult('PROXY p:8080; DIRECT')?.label).toBe('http://p:8080')
    expect(routeFromPacResult('SOCKS5 s:1080')?.kind).toBe('socks5h')
    expect(routeFromPacResult('SOCKS s:1080')?.kind).toBe('socks4a')
    expect(routeFromPacResult('HTTPS p:443; PROXY q:3128')?.label).toBe('http://q:3128')
    expect(() => routeFromPacResult('HTTPS p:443')).toThrow(/can't use/)

    const env = { HTTPS_PROXY: 'http://secure:1', http_proxy: 'plain:2', NO_PROXY: 'skip.test' }
    expect(routeFromEnv(new URL('https://x.test/'), env)?.label).toBe('http://secure:1')
    expect(routeFromEnv(new URL('http://x.test/'), env)?.label).toBe('http://plain:2')
    expect(routeFromEnv(new URL('http://a.skip.test/'), env)).toBeNull()
    expect(routeFromEnv(new URL('http://x.test/'), { ALL_PROXY: 'socks5://s:5' })?.kind).toBe('socks5')
  })

  it('matches client certificate hosts', () => {
    expect(hostMatches('api.example.com', 'api.example.com', '443')).toBe(true)
    expect(hostMatches('API.example.com', 'api.example.com', '443')).toBe(true)
    expect(hostMatches('https://api.example.com/v1', 'api.example.com', '443')).toBe(true)
    expect(hostMatches('*.example.com', 'api.example.com', '443')).toBe(true)
    expect(hostMatches('*.example.com', 'example.com', '443')).toBe(false)
    expect(hostMatches('localhost:8443', 'localhost', '8443')).toBe(true)
    expect(hostMatches('localhost:8443', 'localhost', '443')).toBe(false)
    expect(hostMatches('[::1]:8443', '[::1]', '8443')).toBe(true)
    expect(hostMatches('*', 'anything', '1')).toBe(true)
    expect(hostMatches('', 'anything', '1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Servers: a target, an HTTP proxy (absolute form + CONNECT) and a SOCKS5 proxy

const target = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    let i = 0
    const t = setInterval(() => {
      i++
      res.write(`id: ${i}\nevent: tick\ndata: {"n":${i}}\n\n`)
      if (i === 5) {
        clearInterval(t)
        res.end()
      }
    }, 60)
    req.on('close', () => clearInterval(t))
    return
  }
  if (u.pathname === '/sse-forever') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(': open\n\n')
    let i = 0
    const t = setInterval(() => res.write(`data: ${++i}\n\n`), 30)
    req.on('close', () => clearInterval(t))
    return
  }
  if (u.pathname === '/slow-gzip') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' })
    const gz = zlib.createGzip()
    gz.pipe(res)
    gz.write('first part ')
    gz.flush()
    setTimeout(() => {
      gz.write('second part')
      gz.end()
    }, 250)
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ path: req.url, host: req.headers.host, via: req.headers['x-via-proxy'] ?? null, proxyAuth: req.headers['proxy-authorization'] ?? null }))
})

interface Seen {
  method: string
  url: string
  auth?: string
}

function httpProxy(auth?: string): { server: http.Server; seen: Seen[] } {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers['proxy-authorization'] })
    if (auth && req.headers['proxy-authorization'] !== auth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' })
      return void res.end()
    }
    const t = new URL(req.url!)
    const headers = { ...req.headers, 'x-via-proxy': '1' }
    delete headers['proxy-authorization']
    const up = http.request({ hostname: t.hostname, port: t.port, path: t.pathname + t.search, method: req.method, headers }, (ur) => {
      res.writeHead(ur.statusCode!, ur.headers)
      ur.pipe(res)
    })
    req.pipe(up)
  })
  server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    seen.push({ method: 'CONNECT', url: req.url!, auth: req.headers['proxy-authorization'] })
    if (auth && req.headers['proxy-authorization'] !== auth) return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    const at = req.url!.lastIndexOf(':')
    const up = net.connect(Number(req.url!.slice(at + 1)), req.url!.slice(0, at).replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    socket.on('error', () => up.destroy())
  })
  return { server, seen }
}

function socks5Proxy(auth?: { user: string; pass: string }): { server: net.Server; seen: string[] } {
  const seen: string[] = []
  const server = net.createServer((sock) => {
    sock.on('error', () => {})
    const onRequest = (req: Buffer): void => {
      let host: string
      let at: number
      if (req[3] === 3) {
        host = req.subarray(5, 5 + req[4]).toString()
        at = 5 + req[4]
      } else if (req[3] === 4) {
        host = [...Array(8).keys()].map((i) => req.readUInt16BE(4 + i * 2).toString(16)).join(':')
        at = 20
      } else {
        host = [...req.subarray(4, 8)].join('.')
        at = 8
      }
      const port = req.readUInt16BE(at)
      seen.push(`${host}:${port}`)
      const up = net.connect(port, host, () => {
        sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        up.pipe(sock)
        sock.pipe(up)
      })
      up.on('error', () => sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
    }
    sock.once('data', (greet) => {
      const methods = [...greet.subarray(2, 2 + greet[1])]
      if (!auth) {
        sock.write(Buffer.from([5, 0]))
        return void sock.once('data', onRequest)
      }
      if (!methods.includes(2)) return void sock.end(Buffer.from([5, 0xff]))
      sock.write(Buffer.from([5, 2]))
      sock.once('data', (a) => {
        const user = a.subarray(2, 2 + a[1]).toString()
        const pass = a.subarray(3 + a[1], 3 + a[1] + a[2 + a[1]]).toString()
        if (user !== auth.user || pass !== auth.pass) return void sock.end(Buffer.from([1, 1]))
        sock.write(Buffer.from([1, 0]))
        sock.once('data', onRequest)
      })
    })
  })
  return { server, seen }
}

// Certificates: a throwaway CA, a server certificate it signed, and a client certificate.
function makePki(dir: string): Record<string, string> | undefined {
  const f = (name: string): string => join(dir, name)
  const ssl = (...args: string[]): void => void execFileSync('openssl', args, { stdio: 'ignore' })
  try {
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '1', '-subj', '/CN=FlosForge Test CA')
    writeFileSync(f('san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('srv.key'), '-out', f('srv.csr'), '-subj', '/CN=localhost')
    ssl('x509', '-req', '-in', f('srv.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('srv.pem'), '-days', '1', '-extfile', f('san.ext'))
    ssl('req', '-newkey', 'rsa:2048', '-keyout', f('cli.key'), '-out', f('cli.csr'), '-subj', '/CN=test-client', '-passout', 'pass:secret')
    ssl('x509', '-req', '-in', f('cli.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('cli.pem'), '-days', '1')
    ssl('pkcs12', '-export', '-in', f('cli.pem'), '-inkey', f('cli.key'), '-passin', 'pass:secret', '-out', f('cli.p12'), '-passout', 'pass:secret')
    ssl('x509', '-in', f('ca.pem'), '-outform', 'DER', '-out', f('ca.der'))
    return Object.fromEntries(['ca.pem', 'ca.der', 'srv.key', 'srv.pem', 'cli.key', 'cli.pem', 'cli.p12'].map((k) => [k, f(k)]))
  } catch {
    return undefined
  }
}

const dir = mkdtempSync(join(tmpdir(), 'ffcaller-net-'))
const pki = makePki(dir)

let targetBase = ''
let targetPort = 0
const plain = httpProxy()
const authed = httpProxy(`Basic ${Buffer.from('me:pw').toString('base64')}`)
const socks = socks5Proxy()
const socksAuthed = socks5Proxy({ user: 'me', pass: 'pw' })
const ports: Record<string, number> = {}
let tlsServer: https.Server | undefined
let tlsBase = ''
let mtlsServer: https.Server | undefined
let mtlsBase = ''

beforeAll(async () => {
  targetPort = await listen(target)
  targetBase = `http://127.0.0.1:${targetPort}`
  ports.plain = await listen(plain.server)
  ports.authed = await listen(authed.server)
  ports.socks = await listen(socks.server)
  ports.socksAuthed = await listen(socksAuthed.server)
  if (pki) {
    const tlsOpts = { key: readFileSync(pki['srv.key']), cert: readFileSync(pki['srv.pem']) }
    tlsServer = https.createServer(tlsOpts, (_req, res) => res.end('secure hello'))
    tlsBase = `https://localhost:${await listen(tlsServer)}`
    mtlsServer = https.createServer({ ...tlsOpts, ca: readFileSync(pki['ca.pem']), requestCert: true, rejectUnauthorized: true }, (req, res) => {
      res.end(`client ${(req.socket as TLSSocket).getPeerCertificate().subject.CN}`)
    })
    mtlsBase = `https://localhost:${await listen(mtlsServer)}`
  }
})

afterAll(async () => {
  await Promise.all([target, plain.server, authed.server, socks.server, socksAuthed.server, tlsServer, mtlsServer].filter(Boolean).map((s) => close(s!)))
  rmSync(dir, { recursive: true, force: true })
})

const custom = (url: string, extra: Partial<ProxySettings> = {}): ExecOptions => ({
  ...opts,
  proxy: { mode: 'custom', url, username: '', password: '', bypass: '', ...extra }
})

// ---------------------------------------------------------------------------

describe('HTTP proxy', () => {
  it('sends plain http in absolute form, with credentials only to the proxy', async () => {
    const r = ok(await executeRequest(prep(`${targetBase}/a?b=1`), custom(`http://127.0.0.1:${ports.authed}`, { username: 'me', password: 'pw' })))
    const body = JSON.parse(text(r))
    expect(body).toMatchObject({ path: '/a?b=1', via: '1', proxyAuth: null, host: `127.0.0.1:${targetPort}` })
    expect(authed.seen.at(-1)).toMatchObject({ method: 'GET', url: `${targetBase}/a?b=1` })
    expect(r.proxy).toBe(`http://127.0.0.1:${ports.authed}`)
    // The proxy password never shows up in what the app records as sent.
    expect(r.requestHeaders.some(([k]) => k.toLowerCase() === 'proxy-authorization')).toBe(false)
  })

  it('returns the proxy’s own 407 for plain http without credentials', async () => {
    const r = ok(await executeRequest(prep(`${targetBase}/x`), custom(`127.0.0.1:${ports.authed}`)))
    expect(r.status).toBe(407)
  })

  it('skips the proxy for bypassed hosts', async () => {
    const before = plain.seen.length
    const r = ok(await executeRequest(prep(`${targetBase}/direct`), custom(`127.0.0.1:${ports.plain}`, { bypass: 'localhost, 127.0.0.1' })))
    expect(JSON.parse(text(r)).via).toBeNull()
    expect(r.proxy).toBeUndefined()
    expect(plain.seen.length).toBe(before)
  })

  it('uses no proxy when off or without settings', async () => {
    const before = plain.seen.length
    ok(await executeRequest(prep(`${targetBase}/`), { ...opts, proxy: { ...custom(`127.0.0.1:${ports.plain}`).proxy!, mode: 'off' } }))
    ok(await executeRequest(prep(`${targetBase}/`), opts))
    expect(plain.seen.length).toBe(before)
  })

  it('reports an unreachable proxy as such', async () => {
    const dead = net.createServer()
    const port = await listen(dead)
    await close(dead)
    const r = await executeRequest(prep(`${targetBase}/`), custom(`127.0.0.1:${port}`))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ECONNREFUSED')
      expect(r.error.message).toBe(`Could not reach the proxy http://127.0.0.1:${port}. Connection refused: 127.0.0.1:${port}`)
    }
  })

  it.skipIf(!pki)('tunnels https with CONNECT', async () => {
    const r = ok(
      await executeRequest(prep(`${tlsBase}/`), {
        ...custom(`http://me:pw@127.0.0.1:${ports.authed}`),
        certificates: { ...DEFAULT_CERTIFICATES, caPaths: [pki!['ca.pem']] }
      })
    )
    expect(text(r)).toBe('secure hello')
    expect(authed.seen.at(-1)).toMatchObject({ method: 'CONNECT', url: `localhost:${new URL(tlsBase).port}` })
    expect(r.timings.connect).toBeTypeOf('number')
    expect(r.timings.tls).toBeTypeOf('number')
  })

  it.skipIf(!pki)('explains a 407 on CONNECT', async () => {
    const r = await executeRequest(prep(`${tlsBase}/`), { ...custom(`127.0.0.1:${ports.authed}`), verifySsl: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('EPROXYAUTH')
      expect(r.error.message).toMatch(/needs a username and password \(407\)/)
    }
  })
})

describe('SOCKS proxy', () => {
  it('tunnels http through socks5h, sending the host name', async () => {
    const r = ok(await executeRequest(prep(`http://localhost:${targetPort}/s`), custom(`socks5h://127.0.0.1:${ports.socks}`)))
    expect(JSON.parse(text(r)).path).toBe('/s')
    expect(socks.seen.at(-1)).toBe(`localhost:${targetPort}`)
    expect(r.proxy).toBe(`socks5h://127.0.0.1:${ports.socks}`)
  })

  it('resolves names itself for socks5', async () => {
    ok(await executeRequest(prep(`http://localhost:${targetPort}/s`), custom(`socks5://127.0.0.1:${ports.socks}`)))
    expect(socks.seen.at(-1)).toBe(`127.0.0.1:${targetPort}`)
  })

  it('logs in with a username and password', async () => {
    ok(await executeRequest(prep(`${targetBase}/`), custom(`socks5h://127.0.0.1:${ports.socksAuthed}`, { username: 'me', password: 'pw' })))
    const r = await executeRequest(prep(`${targetBase}/`), custom(`socks5h://127.0.0.1:${ports.socksAuthed}`, { username: 'me', password: 'nope' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('EPROXYAUTH')
    const anon = await executeRequest(prep(`${targetBase}/`), custom(`socks5h://127.0.0.1:${ports.socksAuthed}`))
    expect(anon.ok).toBe(false)
    if (!anon.ok) expect(anon.error.message).toMatch(/needs a username and password/)
  })

  it('reports targets the proxy cannot reach', async () => {
    const dead = net.createServer()
    const port = await listen(dead)
    await close(dead)
    const r = await executeRequest(prep(`http://127.0.0.1:${port}/`), custom(`socks5h://127.0.0.1:${ports.socks}`))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/could not connect to 127\.0\.0\.1:\d+: connection refused/)
  })

  it.skipIf(!pki)('tunnels https', async () => {
    const r = ok(
      await executeRequest(prep(`${tlsBase}/`), {
        ...custom(`socks5h://127.0.0.1:${ports.socks}`),
        certificates: { ...DEFAULT_CERTIFICATES, caPaths: [pki!['ca.pem']] }
      })
    )
    expect(text(r)).toBe('secure hello')
  })
})

describe.skipIf(!pki)('certificates', () => {
  const certs = (c: Partial<CertificateSettings>): ExecOptions => ({ ...opts, certificates: { ...DEFAULT_CERTIFICATES, ...c } })
  const client = (c: Partial<CertificateSettings['client'][number]>): CertificateSettings['client'][number] => ({
    id: 'c',
    enabled: true,
    host: 'localhost',
    certPath: '',
    keyPath: '',
    pfxPath: '',
    passphrase: '',
    ...c
  })

  it('trusts an extra CA certificate, as PEM or DER', async () => {
    expect((await executeRequest(prep(`${tlsBase}/`), opts)).ok).toBe(false)
    expect(text(ok(await executeRequest(prep(`${tlsBase}/`), certs({ caPaths: [pki!['ca.pem']] }))))).toBe('secure hello')
    expect(text(ok(await executeRequest(prep(`${tlsBase}/`), certs({ caPaths: [pki!['ca.der']] }))))).toBe('secure hello')
  })

  it('reports a missing CA file', async () => {
    const r = await executeRequest(prep(`${tlsBase}/`), certs({ caPaths: [join(dir, 'nope.pem')] }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ECERTFILE')
      expect(r.error.message).toMatch(/Could not read the CA certificate .*nope\.pem/)
    }
  })

  it('sends a client certificate to the hosts it is for', async () => {
    const ca = [pki!['ca.pem']]
    const without = await executeRequest(prep(`${mtlsBase}/`), certs({ caPaths: ca }))
    expect(without.ok).toBe(false)

    const pem = client({ certPath: pki!['cli.pem'], keyPath: pki!['cli.key'], passphrase: 'secret' })
    expect(text(ok(await executeRequest(prep(`${mtlsBase}/`), certs({ caPaths: ca, client: [pem] }))))).toBe('client test-client')

    const pfx = client({ host: `localhost:${new URL(mtlsBase).port}`, pfxPath: pki!['cli.p12'], passphrase: 'secret' })
    expect(text(ok(await executeRequest(prep(`${mtlsBase}/`), certs({ caPaths: ca, client: [pfx] }))))).toBe('client test-client')

    // Not for this host, or turned off: not sent.
    expect((await executeRequest(prep(`${mtlsBase}/`), certs({ caPaths: ca, client: [{ ...pem, host: 'other.test' }] }))).ok).toBe(false)
    expect((await executeRequest(prep(`${mtlsBase}/`), certs({ caPaths: ca, client: [{ ...pem, enabled: false }] }))).ok).toBe(false)
  })

  it('explains a wrong passphrase', async () => {
    const r = await executeRequest(
      prep(`${mtlsBase}/`),
      certs({ caPaths: [pki!['ca.pem']], client: [client({ certPath: pki!['cli.pem'], keyPath: pki!['cli.key'], passphrase: 'wrong' })] })
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ECERTFILE')
      expect(r.error.message).toBe('Could not use the client certificate for localhost: wrong passphrase')
    }
  })
})

describe('live responses', () => {
  const collect = (): { events: ExecProgress[]; onProgress: (p: ExecProgress) => void } => {
    const events: ExecProgress[] = []
    return { events, onProgress: (p) => events.push(p) }
  }

  it('reports event streams as they arrive and exempts them from the timeout', async () => {
    const { events, onProgress } = collect()
    const r = ok(await executeRequest(prep(`${targetBase}/sse`), { ...opts, timeoutMs: 150 }, undefined, undefined, onProgress))
    expect(text(r)).toContain('data: {"n":5}')
    expect(events[0]).toMatchObject({ type: 'head', status: 200 })
    const data = events.filter((e) => e.type === 'data')
    expect(data.length).toBeGreaterThan(1)
    expect(data.map((e) => (e.type === 'data' ? e.text : '')).join('')).toContain('data: {"n":1}')
  })

  it('still times out event streams without a live view (CLI, scripts)', async () => {
    const r = await executeRequest(prep(`${targetBase}/sse`), { ...opts, timeoutMs: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('ETIMEDOUT')
  })

  it('keeps what arrived when a stream is stopped', async () => {
    const ctl = new AbortController()
    const { onProgress } = ((): { onProgress: (p: ExecProgress) => void } => {
      let seen = 0
      return {
        onProgress: (p) => {
          if (p.type === 'data' && p.text.includes('data:') && ++seen === 2) ctl.abort()
        }
      }
    })()
    const r = ok(await executeRequest(prep(`${targetBase}/sse-forever`), opts, ctl.signal, undefined, onProgress))
    expect(r.incomplete).toBe('Stopped before the response finished')
    expect(text(r)).toContain('data: 1')
  })

  it('cancels outright before the head arrives', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const r = await executeRequest(prep(`${targetBase}/sse`), opts, ctl.signal, undefined, () => {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('ECANCELLED')
  })

  it('decompresses live text and sends nothing for quick responses', async () => {
    const slow = collect()
    const r = ok(await executeRequest(prep(`${targetBase}/slow-gzip`), opts, undefined, undefined, slow.onProgress))
    expect(text(r)).toBe('first part second part')
    expect(slow.events.map((e) => (e.type === 'data' ? e.text : '')).join('')).toContain('first part')

    const quick = collect()
    ok(await executeRequest(prep(`${targetBase}/quick`), opts, undefined, undefined, quick.onProgress))
    expect(quick.events).toEqual([])
  })
})
