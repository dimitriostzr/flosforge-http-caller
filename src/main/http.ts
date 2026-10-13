import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { ExecOptions, ExecResult, PreparedBody, PreparedRequest, Timings } from '@shared/types'
import type { CookieStore } from './cookies'

type HeaderList = [string, string][]

let userAgent = 'FlosForge-Caller'

/** e.g. setUserAgent(`FlosForge-Caller/${app.getVersion()}`) */
export function setUserAgent(ua: string): void {
  userAgent = ua
}

class ExecError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Methods for which Node would not frame an empty body; everything else gets Content-Length: 0
const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const now = (): number => performance.now()

// ---------------------------------------------------------------------------
// Header helpers (case-insensitive, order and duplicates preserved)

function hasHeader(headers: HeaderList, name: string): boolean {
  const n = name.toLowerCase()
  return headers.some(([k]) => k.toLowerCase() === n)
}

function getHeader(headers: HeaderList, name: string): string | undefined {
  const n = name.toLowerCase()
  return headers.find(([k]) => k.toLowerCase() === n)?.[1]
}

function withoutHeaders(headers: HeaderList, ...names: string[]): HeaderList {
  const drop = new Set(names.map((n) => n.toLowerCase()))
  return headers.filter(([k]) => !drop.has(k.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Body

interface BuiltBody {
  data?: Buffer
  /** Content-Type to set (multipart only). */
  contentType?: string
}

async function readBodyFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (err) {
    throw new ExecError(`Could not read file: ${path} (${(err as Error).message})`, 'EFILE')
  }
}

function escapeDisposition(s: string): string {
  return s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function boundaryFrom(contentType: string | undefined): string | undefined {
  const m = contentType && /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return m ? m[1] ?? m[2] : undefined
}

async function buildBody(body: PreparedBody, headers: HeaderList): Promise<BuiltBody> {
  switch (body.type) {
    case 'none':
      return {}
    case 'text':
      return { data: Buffer.from(body.text, 'utf8') }
    case 'file':
      return { data: await readBodyFile(body.path) }
    case 'multipart': {
      const userCt = getHeader(headers, 'content-type')
      const boundary = boundaryFrom(userCt) ?? `----FlosForgeFormBoundary${randomBytes(12).toString('hex')}`
      const parts: Buffer[] = []
      for (const f of body.fields) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDisposition(f.name)}"`
        let content: Buffer
        if (f.filePath !== undefined) {
          content = await readBodyFile(f.filePath)
          head += `; filename="${escapeDisposition(basename(f.filePath))}"\r\nContent-Type: ${f.contentType || mimeFor(f.filePath)}`
        } else {
          content = Buffer.from(f.value ?? '', 'utf8')
          if (f.contentType) head += `\r\nContent-Type: ${f.contentType}`
        }
        parts.push(Buffer.from(`${head}\r\n\r\n`, 'utf8'), content, Buffer.from('\r\n'))
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`))
      const contentType = boundaryFrom(userCt) ? undefined : `multipart/form-data; boundary=${boundary}`
      return { data: Buffer.concat(parts), contentType }
    }
  }
}

// ---------------------------------------------------------------------------
// Decompression

const decoders: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: (b) => promisify(zlib.gunzip)(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  'x-gzip': (b) => promisify(zlib.gunzip)(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  // "deflate" is meant to be zlib-wrapped, but some servers send raw deflate
  deflate: (b) =>
    promisify(zlib.inflate)(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).catch(() =>
      promisify(zlib.inflateRaw)(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    ),
  br: (b) => promisify(zlib.brotliDecompress)(b)
}

async function decompress(raw: Buffer, encoding: string | undefined): Promise<Buffer> {
  if (!encoding || raw.length === 0) return raw
  // Encodings are listed in the order applied, so undo them in reverse
  const codings = encoding
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'identity')
    .reverse()
  let out = raw
  for (const c of codings) {
    const dec = decoders[c]
    if (!dec) return raw
    try {
      out = await dec(out)
    } catch {
      return raw
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Errors

const CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH'
])

function friendlyError(err: unknown, url?: URL): { message: string; code?: string } {
  if (err instanceof ExecError) return { message: err.message, code: err.code }
  const e = err as NodeJS.ErrnoException & { reason?: string }
  const code = e?.code
  const message = e?.message ?? String(err)
  const host = url?.hostname.replace(/^\[|\]$/g, '') ?? ''
  const port = url ? url.port || (url.protocol === 'https:' ? '443' : '80') : ''
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
    case 'EAI_NONAME':
      return { message: `Could not resolve host: ${host}`, code }
    case 'ECONNREFUSED':
      return { message: `Connection refused: ${host}:${port}`, code }
    case 'ECONNRESET':
      return { message: `Connection reset by server (${message})`, code }
    case 'EPIPE':
      return { message: 'Connection closed by server while sending the request', code }
    case 'ETIMEDOUT':
      return { message: `Connection timed out: ${host}:${port}`, code }
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { message: `Host unreachable: ${host}:${port}`, code }
    case 'ERR_INVALID_HTTP_TOKEN':
    case 'ERR_INVALID_CHAR':
    case 'ERR_HTTP_INVALID_HEADER_VALUE':
      return { message: `Invalid header: ${message}`, code }
  }
  if (code && (CERT_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS_CERT'))) {
    return {
      message: `SSL certificate problem: ${message}. You can disable SSL verification in Settings.`,
      code
    }
  }
  if (code && (code === 'EPROTO' || code.startsWith('ERR_SSL'))) {
    return { message: `SSL error: ${message}`, code }
  }
  if (code && code.startsWith('HPE_')) {
    return { message: `Invalid HTTP response from server: ${e.reason ?? message}`, code }
  }
  return { message, code }
}

// ---------------------------------------------------------------------------
// Single exchange

interface HopResult {
  status: number
  statusText: string
  httpVersion: string
  headers: HeaderList
  raw: Buffer
  headersSize: number
  remoteAddress?: string
  timings: Omit<Timings, 'total'>
}

/** Transport options for a URL; a proxy agent could be plugged in here. */
function transportFor(url: URL, opts: ExecOptions): { mod: typeof http | typeof https; agent: http.Agent } {
  if (url.protocol === 'https:') {
    return { mod: https, agent: new https.Agent({ keepAlive: false, rejectUnauthorized: opts.verifySsl }) }
  }
  return { mod: http, agent: new http.Agent({ keepAlive: false }) }
}

function sendOnce(
  url: URL,
  method: string,
  headers: HeaderList,
  data: Buffer | undefined,
  opts: ExecOptions,
  signal: AbortSignal
): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const { mod, agent } = transportFor(url, opts)
    const t0 = now()
    let tLookup: number | undefined
    let tConnect: number | undefined
    let tTls: number | undefined
    let tResponse = 0
    let remoteAddress: string | undefined
    let settled = false
    let req: http.ClientRequest

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      agent.destroy()
      fn()
    }
    const fail = (err: unknown): void => finish(() => reject(err))
    const onAbort = (): void => {
      fail(signal.reason)
      req?.destroy()
    }

    try {
      req = mod.request({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        agent,
        setHost: false,
        rejectUnauthorized: opts.verifySsl,
        // Array form keeps the user's casing, order and duplicates
        headers: headers.flat()
      })
    } catch (err) {
      return fail(err)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    req.on('socket', (socket) => {
      socket.once('lookup', () => (tLookup = now()))
      socket.once('connect', () => {
        tConnect = now()
        remoteAddress = socket.remoteAddress
      })
      socket.once('secureConnect', () => (tTls = now()))
    })
    req.on('error', fail)
    req.on('close', () => fail(new ExecError('Connection closed before the response was complete', 'ECONNRESET')))

    req.on('response', (res) => {
      tResponse = now()
      remoteAddress ??= res.socket?.remoteAddress
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('error', fail)
      res.on('end', () => {
        const tEnd = now()
        const rh = res.rawHeaders
        const pairs: HeaderList = []
        let headersSize = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage ?? ''}\r\n`.length + 2
        for (let i = 0; i < rh.length; i += 2) {
          pairs.push([rh[i], rh[i + 1]])
          headersSize += rh[i].length + rh[i + 1].length + 4
        }
        const ready = tTls ?? tConnect ?? tLookup ?? t0
        finish(() =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            httpVersion: res.httpVersion,
            headers: pairs,
            raw: Buffer.concat(chunks),
            headersSize,
            remoteAddress,
            timings: {
              dns: tLookup !== undefined ? tLookup - t0 : undefined,
              connect: tConnect !== undefined ? tConnect - (tLookup ?? t0) : undefined,
              tls: tTls !== undefined && tConnect !== undefined ? tTls - tConnect : undefined,
              firstByte: tResponse - ready,
              download: tEnd - tResponse
            }
          })
        )
      })
    })

    req.end(data)
  })
}

// ---------------------------------------------------------------------------
// Public entry point

function parseUrl(input: string): URL {
  let s = input.trim()
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `http://${s}`
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new ExecError(`Invalid URL: ${input}`, 'EINVALIDURL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ExecError(`Unsupported protocol: ${url.protocol.replace(/:$/, '')} (only http and https are supported)`, 'EINVALIDURL')
  }
  if (!url.hostname) throw new ExecError(`Invalid URL: ${input}`, 'EINVALIDURL')
  return url
}

/** Final header list for one hop: user headers + defaults + cookies + framing. */
function hopHeaders(
  url: URL,
  base: HeaderList,
  jarCookie: string,
  contentType: string | undefined,
  data: Buffer | undefined,
  method: string
): HeaderList {
  const out: HeaderList = []
  if (!hasHeader(base, 'host')) out.push(['Host', url.host])
  let cookieMerged = !jarCookie
  for (const [k, v] of base) {
    if (!k) continue
    const lk = k.toLowerCase()
    if (lk === 'content-length') continue
    if (lk === 'cookie' && !cookieMerged) {
      out.push([k, v ? `${v}; ${jarCookie}` : jarCookie])
      cookieMerged = true
      continue
    }
    if (lk === 'content-type' && contentType) {
      out.push([k, contentType])
      continue
    }
    out.push([k, v])
  }
  if (!hasHeader(out, 'user-agent')) out.push(['User-Agent', userAgent])
  if (!hasHeader(out, 'accept')) out.push(['Accept', '*/*'])
  if (!hasHeader(out, 'accept-encoding')) out.push(['Accept-Encoding', 'gzip, deflate, br'])
  if (!cookieMerged) out.push(['Cookie', jarCookie])
  if (contentType && !hasHeader(out, 'content-type')) out.push(['Content-Type', contentType])
  if (!hasHeader(out, 'transfer-encoding')) {
    if (data) out.push(['Content-Length', String(data.length)])
    else if (!NO_BODY_METHODS.has(method.toUpperCase())) out.push(['Content-Length', '0'])
  }
  if (!hasHeader(out, 'connection')) out.push(['Connection', 'close'])
  return out
}

export async function executeRequest(
  req: PreparedRequest,
  opts: ExecOptions,
  signal?: AbortSignal,
  jar?: CookieStore
): Promise<ExecResult> {
  const ctl = new AbortController()
  const onCancel = (): void => ctl.abort(new ExecError('Request cancelled', 'ECANCELLED'))
  let timer: ReturnType<typeof setTimeout> | undefined
  let url: URL | undefined
  try {
    if (signal?.aborted) throw new ExecError('Request cancelled', 'ECANCELLED')
    signal?.addEventListener('abort', onCancel, { once: true })
    if (opts.timeoutMs > 0) {
      timer = setTimeout(
        () => ctl.abort(new ExecError(`Request timed out after ${opts.timeoutMs}ms`, 'ETIMEDOUT')),
        opts.timeoutMs
      )
    }

    url = parseUrl(req.url)
    let method = req.method.toUpperCase() || 'GET'
    let headers: HeaderList = req.headers.map(([k, v]) => [k, v])
    let { data, contentType } = await buildBody(req.body, headers)
    if (ctl.signal.aborted) throw ctl.signal.reason

    const redirects: { url: string; status: number }[] = []
    const tStart = now()
    for (;;) {
      const jarCookie = opts.useCookieJar && jar ? await jar.getCookieHeader(url.href) : ''
      const sent = hopHeaders(url, headers, jarCookie, contentType, data, method)
      const hop = await sendOnce(url, method, sent, data, opts, ctl.signal)

      if (opts.useCookieJar && jar) {
        const setCookie = hop.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v)
        await jar.storeFromResponse(url.href, setCookie)
      }

      const location = getHeader(hop.headers, 'location')
      if (opts.followRedirects && REDIRECT_STATUSES.has(hop.status) && location) {
        if (redirects.length >= opts.maxRedirects) {
          throw new ExecError(`Exceeded maximum number of redirects (${opts.maxRedirects})`, 'ETOOMANYREDIRECTS')
        }
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new ExecError(`Invalid redirect location: ${location}`, 'EINVALIDURL')
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new ExecError(`Unsupported redirect protocol: ${next.protocol}`, 'EINVALIDURL')
        }
        redirects.push({ url: url.href, status: hop.status })
        const toGet =
          (hop.status === 303 && method !== 'HEAD') ||
          ((hop.status === 301 || hop.status === 302) && method !== 'GET' && method !== 'HEAD')
        if (toGet) {
          method = 'GET'
          data = undefined
          contentType = undefined
          headers = withoutHeaders(headers, 'content-type', 'content-length', 'transfer-encoding')
        }
        if (next.host !== url.host) {
          headers = withoutHeaders(headers, 'authorization', 'cookie', 'host')
        }
        url = next
        continue
      }

      const body = await decompress(hop.raw, getHeader(hop.headers, 'content-encoding'))
      return {
        ok: true,
        response: {
          status: hop.status,
          statusText: hop.statusText,
          httpVersion: hop.httpVersion,
          headers: hop.headers,
          body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          bodySize: hop.raw.length,
          headersSize: hop.headersSize,
          timings: { ...hop.timings, total: now() - tStart },
          url: url.href,
          redirects,
          remoteAddress: hop.remoteAddress,
          requestHeaders: sent
        }
      }
    }
  } catch (err) {
    return { ok: false, error: friendlyError(err, url) }
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onCancel)
  }
}
