import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExecOptions, ExecResult, HttpResponse, PreparedBody, PreparedRequest } from '@shared/types'
import { executeRequest, setUserAgent } from '../src/main/http'
import { CookieStore } from '../src/main/cookies'

const opts: ExecOptions = {
  timeoutMs: 5000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  useCookieJar: true
}

let execCounter = 0
function prep(method: string, url: string, headers: [string, string][] = [], body: PreparedBody = { type: 'none' }): PreparedRequest {
  return { execId: String(++execCounter), method, url, headers, body }
}

function ok(r: ExecResult): HttpResponse {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.response
}

const text = (r: HttpResponse): string => Buffer.from(r.body).toString('utf8')
const json = (r: HttpResponse): Echo => JSON.parse(text(r)) as Echo

interface Echo {
  method: string
  url: string
  rawHeaders: string[]
  headers: Record<string, string>
  body: string
}

const PAYLOAD = 'hello compressed world '.repeat(50)

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const u = new URL(req.url ?? '/', 'http://x')
    const echo = (): void => {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          rawHeaders: req.rawHeaders,
          headers: req.headers,
          body: body.toString('latin1')
        })
      )
    }
    switch (u.pathname) {
      case '/gzip':
        res.setHeader('Content-Encoding', 'gzip')
        return void res.end(zlib.gzipSync(PAYLOAD))
      case '/br':
        res.setHeader('Content-Encoding', 'br')
        return void res.end(zlib.brotliCompressSync(PAYLOAD))
      case '/deflate':
        res.setHeader('Content-Encoding', 'deflate')
        return void res.end(zlib.deflateSync(PAYLOAD))
      case '/deflate-raw':
        res.setHeader('Content-Encoding', 'deflate')
        return void res.end(zlib.deflateRawSync(PAYLOAD))
      case '/bad-gzip':
        res.setHeader('Content-Encoding', 'gzip')
        return void res.end('not gzip at all')
      case '/redirect': {
        const status = Number(u.searchParams.get('status') ?? 302)
        res.statusCode = status
        res.setHeader('Location', u.searchParams.get('to') ?? '/echo')
        return void res.end('redirecting')
      }
      case '/loop':
        res.statusCode = 302
        res.setHeader('Location', '/loop')
        return void res.end()
      case '/slow':
        setTimeout(() => {
          if (!res.destroyed) res.end('late')
        }, 2000)
        return
      case '/set-cookie':
        res.setHeader('Set-Cookie', ['sid=abc123; Path=/', 'loose', 'theme=dark; Path=/; Max-Age=3600'])
        return void res.end('ok')
      case '/set-cookie-redirect':
        res.statusCode = 302
        res.setHeader('Set-Cookie', 'hop=1; Path=/')
        res.setHeader('Location', '/echo')
        return void res.end()
      case '/no-content':
        res.statusCode = 204
        return void res.end()
      default:
        return echo()
    }
  })
}

let server: http.Server
let base = ''
let tmp = ''

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ffcaller-http-test-'))
  server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(tmp, { recursive: true, force: true })
})

describe('executeRequest', () => {
  it('sends headers in order with user casing and default headers', async () => {
    setUserAgent('Dispatch/9.9.9')
    const r = ok(
      await executeRequest(
        prep('GET', `${base}/echo?a=1&b=two words`, [
          ['X-Custom', 'one'],
          ['x-dup', 'a'],
          ['x-dup', 'b']
        ]),
        opts
      )
    )
    expect(r.status).toBe(200)
    expect(r.statusText).toBe('OK')
    expect(r.httpVersion).toBe('1.1')
    const e = json(r)
    expect(e.method).toBe('GET')
    expect(e.url).toBe('/echo?a=1&b=two%20words')
    const names = e.rawHeaders.filter((_, i) => i % 2 === 0)
    expect(names.indexOf('X-Custom')).toBeLessThan(names.indexOf('x-dup'))
    expect(names.filter((n) => n === 'x-dup')).toHaveLength(2)
    expect(e.headers['user-agent']).toBe('Dispatch/9.9.9')
    expect(e.headers['accept']).toBe('*/*')
    expect(e.headers['accept-encoding']).toBe('gzip, deflate, br')
    expect(e.headers['content-type']).toBeUndefined()
    expect(r.requestHeaders).toContainEqual(['X-Custom', 'one'])
    expect(r.requestHeaders.find(([k]) => k === 'Host')?.[1]).toBe(new URL(base).host)
    expect(r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]).toBe('application/json')
    expect(r.remoteAddress).toBe('127.0.0.1')
    expect(r.url).toBe(`${base}/echo?a=1&b=two%20words`)
    expect(r.headersSize).toBeGreaterThan(20)
    setUserAgent('Dispatch')
  })

  it('does not override user-supplied default headers', async () => {
    const r = ok(
      await executeRequest(
        prep('GET', `${base}/echo`, [
          ['user-agent', 'mine'],
          ['ACCEPT', 'application/json']
        ]),
        opts
      )
    )
    const e = json(r)
    expect(e.headers['user-agent']).toBe('mine')
    expect(e.headers['accept']).toBe('application/json')
  })

  it('populates timings', async () => {
    const r = ok(await executeRequest(prep('GET', `${base}/echo`), opts))
    const t = r.timings
    expect(t.dns).toBeUndefined() // IP literal: no lookup
    expect(t.connect).toBeTypeOf('number')
    expect(t.tls).toBeUndefined()
    expect(t.firstByte).toBeGreaterThanOrEqual(0)
    expect(t.download).toBeGreaterThanOrEqual(0)
    expect(t.total).toBeGreaterThanOrEqual(t.firstByte)
  })

  it('measures dns for hostnames', async () => {
    const port = new URL(base).port
    const r = ok(await executeRequest(prep('GET', `http://localhost:${port}/echo`), opts))
    expect(r.timings.dns).toBeTypeOf('number')
  })

  it('accepts scheme-less URLs', async () => {
    const r = ok(await executeRequest(prep('GET', `${base.replace('http://', '')}/echo`), opts))
    expect(r.status).toBe(200)
    expect(r.url.startsWith('http://')).toBe(true)
  })

  it('rejects invalid URLs', async () => {
    const r = await executeRequest(prep('GET', 'http://exa mple.com:99999/'), opts)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('EINVALIDURL')
      expect(r.error.message).toMatch(/^Invalid URL: /)
    }
    const ftp = await executeRequest(prep('GET', 'ftp://example.com/'), opts)
    expect(!ftp.ok && ftp.error.code).toBe('EINVALIDURL')
  })

  it('POSTs a text body with content-length', async () => {
    const r = ok(
      await executeRequest(
        prep('POST', `${base}/echo`, [['Content-Type', 'application/json']], { type: 'text', text: '{"héllo":1}' }),
        opts
      )
    )
    const e = json(r)
    expect(e.method).toBe('POST')
    expect(Buffer.from(e.body, 'latin1').toString('utf8')).toBe('{"héllo":1}')
    expect(e.headers['content-length']).toBe(String(Buffer.byteLength('{"héllo":1}')))
    expect(e.headers['content-type']).toBe('application/json')
    expect(e.headers['transfer-encoding']).toBeUndefined()
  })

  it('sends Content-Length: 0 for bodiless POST', async () => {
    const e = json(ok(await executeRequest(prep('POST', `${base}/echo`), opts)))
    expect(e.headers['content-length']).toBe('0')
    expect(e.headers['transfer-encoding']).toBeUndefined()
  })

  it('sends multipart/form-data', async () => {
    const file = join(tmp, 'note.txt')
    writeFileSync(file, 'file contents\n')
    const r = ok(
      await executeRequest(
        prep('POST', `${base}/echo`, [], {
          type: 'multipart',
          fields: [
            { name: 'title', value: 'Hello "there"' },
            { name: 'upload', filePath: file }
          ]
        }),
        opts
      )
    )
    const e = json(r)
    const ct = e.headers['content-type']
    const m = /^multipart\/form-data; boundary=(.+)$/.exec(ct)
    expect(m).not.toBeNull()
    const b = m![1]
    expect(e.body).toBe(
      `--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello "there"\r\n` +
        `--${b}\r\nContent-Disposition: form-data; name="upload"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nfile contents\n\r\n` +
        `--${b}--\r\n`
    )
    expect(e.headers['content-length']).toBe(String(Buffer.byteLength(e.body, 'latin1')))
  })

  it('replaces a boundary-less user multipart content-type', async () => {
    const e = json(
      ok(
        await executeRequest(
          prep('POST', `${base}/echo`, [['content-type', 'multipart/form-data']], {
            type: 'multipart',
            fields: [{ name: 'a', value: '1' }]
          }),
          opts
        )
      )
    )
    expect(e.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(e.rawHeaders).toContain('content-type')
  })

  it('sends a file body', async () => {
    const file = join(tmp, 'blob.bin')
    const bytes = Buffer.from([0, 1, 2, 250, 255])
    writeFileSync(file, bytes)
    const e = json(ok(await executeRequest(prep('PUT', `${base}/echo`, [], { type: 'file', path: file }), opts)))
    expect(Buffer.from(e.body, 'latin1')).toEqual(bytes)
    expect(e.headers['content-length']).toBe('5')
  })

  it('reports unreadable files with EFILE', async () => {
    const r = await executeRequest(prep('PUT', `${base}/echo`, [], { type: 'file', path: join(tmp, 'missing') }), opts)
    expect(!r.ok && r.error.code).toBe('EFILE')
  })

  it.each(['gzip', 'br', 'deflate', 'deflate-raw'])('decompresses %s', async (enc) => {
    const r = ok(await executeRequest(prep('GET', `${base}/${enc}`), opts))
    expect(text(r)).toBe(PAYLOAD)
    expect(r.bodySize).toBeLessThan(PAYLOAD.length)
    expect(r.body).toBeInstanceOf(Uint8Array)
  })

  it('returns the raw body when decompression fails', async () => {
    const r = ok(await executeRequest(prep('GET', `${base}/bad-gzip`), opts))
    expect(text(r)).toBe('not gzip at all')
  })

  it('handles HEAD and 204', async () => {
    const h = ok(await executeRequest(prep('HEAD', `${base}/echo`), opts))
    expect(h.status).toBe(200)
    expect(h.body.byteLength).toBe(0)
    const n = ok(await executeRequest(prep('GET', `${base}/no-content`), opts))
    expect(n.status).toBe(204)
    expect(n.body.byteLength).toBe(0)
  })

  it('follows 302 for POST by switching to GET and dropping the body', async () => {
    const r = ok(
      await executeRequest(
        prep(
          'POST',
          `${base}/redirect?status=302`,
          [
            ['Content-Type', 'text/plain'],
            ['Authorization', 'Bearer x']
          ],
          { type: 'text', text: 'payload' }
        ),
        opts
      )
    )
    const e = json(r)
    expect(e.method).toBe('GET')
    expect(e.body).toBe('')
    expect(e.headers['content-type']).toBeUndefined()
    expect(e.headers['content-length']).toBeUndefined()
    expect(e.headers['authorization']).toBe('Bearer x') // same host keeps auth
    expect(r.redirects).toEqual([{ url: `${base}/redirect?status=302`, status: 302 }])
    expect(r.url).toBe(`${base}/echo`)
    expect(r.timings.total).toBeGreaterThanOrEqual(r.timings.firstByte)
  })

  it('follows 307 keeping method and body', async () => {
    const r = ok(
      await executeRequest(
        prep('PUT', `${base}/redirect?status=307`, [['Content-Type', 'text/plain']], { type: 'text', text: 'payload' }),
        opts
      )
    )
    const e = json(r)
    expect(e.method).toBe('PUT')
    expect(e.body).toBe('payload')
    expect(e.headers['content-type']).toBe('text/plain')
  })

  it('strips Authorization on cross-host redirects', async () => {
    const port = new URL(base).port
    const to = encodeURIComponent(`http://localhost:${port}/echo`)
    const e = json(
      ok(await executeRequest(prep('GET', `${base}/redirect?status=301&to=${to}`, [['Authorization', 'Bearer x']]), opts))
    )
    expect(e.headers['authorization']).toBeUndefined()
  })

  it('fails after too many redirects', async () => {
    const r = await executeRequest(prep('GET', `${base}/loop`), { ...opts, maxRedirects: 3 })
    expect(!r.ok && r.error.code).toBe('ETOOMANYREDIRECTS')
  })

  it('returns the redirect itself when followRedirects is false', async () => {
    const r = ok(await executeRequest(prep('GET', `${base}/redirect?status=302`), { ...opts, followRedirects: false }))
    expect(r.status).toBe(302)
    expect(text(r)).toBe('redirecting')
    expect(r.redirects).toEqual([])
  })

  it('times out', async () => {
    const r = await executeRequest(prep('GET', `${base}/slow`), { ...opts, timeoutMs: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ETIMEDOUT')
      expect(r.error.message).toBe('Request timed out after 150ms')
    }
  })

  it('can be cancelled', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t = Date.now()
    const r = await executeRequest(prep('GET', `${base}/slow`), opts, ac.signal)
    expect(Date.now() - t).toBeLessThan(1500)
    expect(r).toEqual({ ok: false, error: { message: 'Request cancelled', code: 'ECANCELLED' } })
    const pre = new AbortController()
    pre.abort()
    const r2 = await executeRequest(prep('GET', `${base}/echo`), opts, pre.signal)
    expect(!r2.ok && r2.error.code).toBe('ECANCELLED')
  })

  it('reports connection refused', async () => {
    const tmpServer = net.createServer()
    await new Promise<void>((r) => tmpServer.listen(0, '127.0.0.1', r))
    const port = (tmpServer.address() as net.AddressInfo).port
    await new Promise<void>((r) => tmpServer.close(() => r()))
    const r = await executeRequest(prep('GET', `http://127.0.0.1:${port}/`), opts)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ECONNREFUSED')
      expect(r.error.message).toBe(`Connection refused: 127.0.0.1:${port}`)
    }
  })

  it('uses the cookie jar across requests and redirect hops', async () => {
    const jar = new CookieStore()
    ok(await executeRequest(prep('GET', `${base}/set-cookie`), opts, undefined, jar))
    const e = json(ok(await executeRequest(prep('GET', `${base}/echo`, [['Cookie', 'mine=1']]), opts, undefined, jar)))
    expect(e.headers['cookie']).toBe('mine=1; sid=abc123; loose; theme=dark')
    const keys = (await jar.list()).map((c) => c.key)
    expect(keys).toEqual(['', 'sid', 'theme'])

    const jar2 = new CookieStore()
    const r = ok(await executeRequest(prep('GET', `${base}/set-cookie-redirect`), opts, undefined, jar2))
    expect(json(r).headers['cookie']).toBe('hop=1')
    expect(r.requestHeaders).toContainEqual(['Cookie', 'hop=1'])

    // Disabled jar sends nothing
    const e3 = json(ok(await executeRequest(prep('GET', `${base}/echo`), { ...opts, useCookieJar: false }, undefined, jar)))
    expect(e3.headers['cookie']).toBeUndefined()
  })
})

describe('CookieStore', () => {
  it('persists and reloads cookies', async () => {
    const file = join(tmp, 'sub', 'cookies.json')
    const a = new CookieStore(file)
    await a.load()
    await a.storeFromResponse('http://localhost:3000/api', ['a=1; Path=/', 'b=2; Path=/api; HttpOnly', 'bad=; Domain=evil.com'])
    await a.set('https://example.com/', 'c=3; Secure; SameSite=Strict; Max-Age=600')
    await a.flush()
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)

    const b = new CookieStore(file)
    await b.load()
    const list = await b.list()
    expect(list.map((c) => `${c.domain}|${c.key}`)).toEqual(['example.com|c', 'localhost|a', 'localhost|b'])
    const c = list.find((x) => x.key === 'c')!
    expect(c.secure).toBe(true)
    expect(c.sameSite).toBe('strict')
    expect(c.expires).toBeTypeOf('string')
    expect(list.find((x) => x.key === 'b')!.httpOnly).toBe(true)
    expect(await b.getCookieHeader('http://localhost:3000/api/x')).toBe('b=2; a=1')

    await b.remove('localhost', '/', 'a')
    expect(await b.getCookieHeader('http://localhost:3000/')).toBe('')
    await b.removeDomain('.example.com')
    expect((await b.list()).map((x) => x.key)).toEqual(['b'])
    await b.flush()
    const c2 = new CookieStore(file)
    await c2.load()
    expect((await c2.list()).map((x) => x.key)).toEqual(['b'])
    await c2.clear()
    await c2.flush()
    const d = new CookieStore(file)
    await d.load()
    expect(await d.list()).toEqual([])
  })

  it('starts empty on a corrupt file and rejects invalid manual cookies', async () => {
    const file = join(tmp, 'corrupt.json')
    writeFileSync(file, '{not json')
    const s = new CookieStore(file)
    await s.load()
    expect(await s.list()).toEqual([])
    await expect(s.set('http://localhost/', 'x=1; Domain=other.com')).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{not json')
  })
})

// HTTPS with a throwaway self-signed cert (skipped when openssl is unavailable)
function makeCert(dir: string): { key: Buffer; cert: Buffer } | undefined {
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'],
      { stdio: 'ignore' }
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } catch {
    return undefined
  }
}

const certDir = mkdtempSync(join(tmpdir(), 'ffcaller-cert-'))
const pems = makeCert(certDir)

describe.skipIf(!pems)('executeRequest over https', () => {
  let tls: https.Server
  let tlsBase = ''
  beforeAll(async () => {
    tls = https.createServer({ key: pems!.key, cert: pems!.cert }, handler)
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r))
    tlsBase = `https://localhost:${(tls.address() as net.AddressInfo).port}`
  })
  afterAll(async () => {
    tls.closeAllConnections()
    await new Promise<void>((r) => tls.close(() => r()))
    rmSync(certDir, { recursive: true, force: true })
  })

  it('rejects self-signed certificates when verifying', async () => {
    const r = await executeRequest(prep('GET', `${tlsBase}/echo`), opts)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
      expect(r.error.message).toMatch(/^SSL certificate problem: .*Settings → Certificates, or turn off SSL verification/)
    }
  })

  it('accepts them with verifySsl=false and records tls timing', async () => {
    const r = ok(await executeRequest(prep('GET', `${tlsBase}/gzip`), { ...opts, verifySsl: false }))
    expect(text(r)).toBe(PAYLOAD)
    expect(r.timings.tls).toBeTypeOf('number')
    expect(r.timings.dns).toBeTypeOf('number')
  })
})
