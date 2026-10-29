import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { SENSITIVE_HEADER } from '@shared/engine/exports'
import type { ExecOptions, ExecProgress, ExecResult, PreparedBody, PreparedRequest, Timings } from '@shared/types'
import { secureContextFor } from './certificates'
import type { CookieStore } from './cookies'
import { ExecError } from './errors'
import { openTunnel, proxyAuthorization, proxyFor, type Marks, type ProxyRoute } from './proxy'

type HeaderList = [string, string][]

let userAgent = 'FlosForge-Caller'

/** e.g. setUserAgent(`FlosForge-Caller/${app.getVersion()}`) */
export function setUserAgent(ua: string): void {
  userAgent = ua
}

/**
 * Decides whether a request may upload a file and returns the path to read.
 * Throws (an ExecError) to refuse. File paths can come from imported collections,
 * so the app asks the user about files they didn't choose themselves, and the
 * CLI only reads files inside its working directory.
 */
export type FileGuard = (path: string) => Promise<string>

let fileGuard: FileGuard = async (path) => resolve(path)

export function setFileGuard(guard: FileGuard): void {
  fileGuard = guard
}

/** Responses are cut off here, so a hostile server can't exhaust memory. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024

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

/** System pseudo-files that read as environment variables, memory or endless data. */
const SPECIAL_DIRS = ['/proc', '/sys', '/dev']

async function readBodyFile(path: string): Promise<Buffer> {
  // Network (\\server\share, //server) and device (\\.\, \\?\) paths are refused before
  // touching them: on Windows even looking one up sends the user's login to that server.
  const network = (p: string): boolean => /^[\\/]{2}/.test(p)
  if (network(path)) throw new ExecError(`Files on network shares or devices can't be sent: ${path}`, 'EFILE')
  const chosen = await fileGuard(path)
  if (network(chosen)) throw new ExecError(`Files on network shares or devices can't be sent: ${path}`, 'EFILE')
  let real: string
  try {
    real = await realpath(chosen)
  } catch (err) {
    throw new ExecError(`Could not read file: ${path} (${(err as Error).message})`, 'EFILE')
  }
  if (network(real) || SPECIAL_DIRS.some((d) => real === d || real.startsWith(d + sep)))
    throw new ExecError(`System files can't be sent: ${path}`, 'EFILE')
  try {
    if (!(await stat(real)).isFile()) throw new Error('not a regular file')
    return await readFile(real)
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
        // A field's content type comes from the collection: no line breaks, so it
        // can't smuggle extra part headers or parts into the body.
        const fieldType = f.contentType?.replace(/[\r\n]+/g, ' ').trim()
        if (f.filePath !== undefined) {
          content = await readBodyFile(f.filePath)
          head += `; filename="${escapeDisposition(basename(f.filePath))}"\r\nContent-Type: ${fieldType || mimeFor(f.filePath)}`
        } else {
          content = Buffer.from(f.value ?? '', 'utf8')
          if (fieldType) head += `\r\nContent-Type: ${fieldType}`
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

// maxOutputLength stops a small "zip bomb" from expanding into gigabytes; such a
// body is shown as received (still compressed) instead.
const ZLIB_OPTS = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_RESPONSE_BYTES }
const decoders: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: (b) => promisify(zlib.gunzip)(b, ZLIB_OPTS),
  'x-gzip': (b) => promisify(zlib.gunzip)(b, ZLIB_OPTS),
  // "deflate" is meant to be zlib-wrapped, but some servers send raw deflate
  deflate: (b) => promisify(zlib.inflate)(b, ZLIB_OPTS).catch(() => promisify(zlib.inflateRaw)(b, ZLIB_OPTS)),
  br: (b) => promisify(zlib.brotliDecompress)(b, { maxOutputLength: MAX_RESPONSE_BYTES })
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

const CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

function friendlyError(err: unknown, url?: URL, route?: ProxyRoute | null): { message: string; code?: string } {
  if (err instanceof ExecError) return { message: err.message, code: err.code }
  const e = err as NodeJS.ErrnoException & { reason?: string }
  const code = e?.code
  const message = e?.message ?? String(err)
  // Through a proxy every connection goes to the proxy (the server's own failures
  // come back as proxy replies), so connection errors are about the proxy.
  if (route && code && CONNECT_CODES.has(code)) {
    const what = friendlyError(err, new URL(route.label.replace(/^socks\w*:/, 'http:'))).message
    return { message: `Could not reach the proxy ${route.label}. ${what}`, code }
  }
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
      message: `SSL certificate problem: ${message}. Add the server's CA certificate in Settings → Certificates, or turn off SSL verification.`,
      code
    }
  }
  if (code && /CERTIFICATE_REQUIRED|ALERT_HANDSHAKE_FAILURE|ALERT_BAD_CERTIFICATE/.test(code)) {
    return {
      message: `SSL error: ${message}. The server may want a client certificate: add one for this host in Settings → Certificates.`,
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
  incomplete?: string
}

export interface ResponseHead {
  status: number
  statusText: string
  httpVersion: string
  headers: HeaderList
}

interface HopContext {
  opts: ExecOptions
  signal: AbortSignal
  route: ProxyRoute | null
  secureContext?: tls.SecureContext
  /** Called when the response head arrives; may return a consumer that sees each raw body chunk. */
  onHead?: (head: ResponseHead) => ((chunk: Buffer) => void) | undefined
  /** Cancelling after the head arrived resolves with the body so far instead of failing. */
  keepPartial?: boolean
}

interface Transport {
  mod: typeof http | typeof https
  agent: http.Agent
  hostname: string
  port?: number | string
  path: string
  /** Sent to an HTTP proxy that receives the request itself (plain http). */
  proxyAuth?: string
}

/**
 * Where a hop connects and how. Direct; through an HTTP proxy that takes the
 * request in absolute form (plain http); or through a tunnel (CONNECT or SOCKS)
 * that the agent opens before speaking HTTP or TLS over it.
 */
function transportFor(url: URL, ctx: HopContext, marks: Marks): Transport {
  const isHttps = url.protocol === 'https:'
  const tlsOptions: tls.ConnectionOptions = {
    rejectUnauthorized: ctx.opts.verifySsl,
    ...(ctx.secureContext ? { secureContext: ctx.secureContext } : {})
  }
  const agent = isHttps ? new https.Agent({ keepAlive: false, ...tlsOptions }) : new http.Agent({ keepAlive: false })
  const mod = isHttps ? https : http
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const path = `${url.pathname}${url.search}`
  const route = ctx.route
  if (!route) return { mod, agent, hostname: host, port: url.port || undefined, path }

  if (route.kind === 'http' && !isHttps) {
    return {
      mod: http,
      agent,
      hostname: route.host,
      port: route.port,
      path: `${url.protocol}//${url.host}${path}`,
      proxyAuth: proxyAuthorization(route)
    }
  }

  const port = Number(url.port) || (isHttps ? 443 : 80)
  agent.createConnection = (_options, callback) => {
    openTunnel(route, host, port, marks, ctx.signal).then(
      (socket) => {
        if (!isHttps) return callback?.(null, socket)
        const secure = tls.connect({ ...tlsOptions, socket, servername: net.isIP(host) ? undefined : host })
        secure.once('secureConnect', () => (marks.tls ??= now()))
        callback?.(null, secure)
      },
      (err: Error) => callback?.(err, undefined as unknown as Duplex)
    )
    return undefined
  }
  return { mod, agent, hostname: host, port, path }
}

function sendOnce(url: URL, method: string, headers: HeaderList, data: Buffer | undefined, ctx: HopContext): Promise<HopResult> {
  const { signal } = ctx
  return new Promise<HopResult>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const marks: Marks = {}
    const t = transportFor(url, ctx, marks)
    const t0 = now()
    let tResponse = 0
    let remoteAddress: string | undefined
    let settled = false
    let req: http.ClientRequest
    // Set once the head arrived: finishes the hop with what was received.
    let complete: ((incomplete?: string) => void) | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      t.agent.destroy()
      fn()
    }
    const fail = (err: unknown): void => finish(() => reject(err))
    const onAbort = (): void => {
      const reason = signal.reason as ExecError | undefined
      if (complete && ctx.keepPartial && reason?.code === 'ECANCELLED') complete('Stopped before the response finished')
      else fail(signal.reason)
      req?.destroy()
    }

    try {
      req = t.mod.request({
        protocol: url.protocol,
        hostname: t.hostname,
        port: t.port,
        path: t.path,
        method,
        agent: t.agent,
        setHost: false,
        rejectUnauthorized: ctx.opts.verifySsl,
        // Array form keeps the user's casing, order and duplicates
        headers: (t.proxyAuth ? [...headers, ['Proxy-Authorization', t.proxyAuth]] : headers).flat()
      })
    } catch (err) {
      return fail(err)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    req.on('socket', (socket) => {
      socket.once('lookup', () => (marks.lookup ??= now()))
      socket.once('connect', () => {
        marks.connect ??= now()
        remoteAddress = socket.remoteAddress
      })
      socket.once('secureConnect', () => (marks.tls ??= now()))
    })
    req.on('error', fail)
    req.on('close', () => fail(new ExecError('Connection closed before the response was complete', 'ECONNRESET')))

    req.on('response', (res) => {
      tResponse = now()
      remoteAddress ??= res.socket?.remoteAddress
      const rh = res.rawHeaders
      const pairs: HeaderList = []
      let headersSize = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage ?? ''}\r\n`.length + 2
      for (let i = 0; i < rh.length; i += 2) {
        pairs.push([rh[i], rh[i + 1]])
        headersSize += rh[i].length + rh[i + 1].length + 4
      }
      const head: ResponseHead = { status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', httpVersion: res.httpVersion, headers: pairs }
      const onChunk = ctx.onHead?.(head)
      const chunks: Buffer[] = []
      complete = (incomplete) => {
        const tEnd = now()
        const ready = marks.tls ?? marks.connect ?? marks.lookup ?? t0
        finish(() =>
          resolve({
            ...head,
            raw: Buffer.concat(chunks),
            headersSize,
            remoteAddress,
            incomplete,
            timings: {
              dns: marks.lookup !== undefined ? marks.lookup - t0 : undefined,
              connect: marks.connect !== undefined ? marks.connect - (marks.lookup ?? t0) : undefined,
              tls: marks.tls !== undefined && marks.connect !== undefined ? marks.tls - marks.connect : undefined,
              firstByte: tResponse - ready,
              download: tEnd - tResponse
            }
          })
        )
      }
      let received = 0
      res.on('data', (c: Buffer) => {
        if (settled) return
        received += c.length
        if (received > MAX_RESPONSE_BYTES) {
          // Keep what fits and end here; the response is marked incomplete.
          chunks.push(c.subarray(0, c.length - (received - MAX_RESPONSE_BYTES)))
          complete!(`Stopped at ${MAX_RESPONSE_BYTES / 1048576} MB, the most a response can have`)
          req.destroy()
          return
        }
        chunks.push(c)
        onChunk?.(c)
      })
      res.on('error', fail)
      res.on('end', () => complete!())
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

// ---------------------------------------------------------------------------
// Live progress: lets the UI show a response while it arrives

const LIVE_TEXT_LIMIT = 2 * 1024 * 1024
const LIVE_INTERVAL_MS = 80
/** Responses that only end when someone stops them, so they are exempt from the request timeout. */
const STREAM_TYPES = /^(text\/event-stream|application\/(x-)?ndjson|application\/jsonl|application\/x-jsonlines|application\/stream\+json)\b/i
const TEXT_TYPES = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ndjson|x-ndjson|jsonl|x-jsonlines|graphql|x-www-form-urlencoded))/i

function liveDecoder(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null | false {
  const codings = (encoding ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c && c !== 'identity')
  if (!codings.length) return null
  if (codings.length > 1) return false
  switch (codings[0]) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
    case 'deflate':
      return zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH })
    case 'br':
      return zlib.createBrotliDecompress()
  }
  return false
}

/**
 * Forwards the response as it arrives: the head, then text in batches (at most
 * one message every LIVE_INTERVAL_MS). A response that finishes within the
 * first interval sends nothing, so ordinary requests cost no extra messages.
 */
function liveForwarder(head: ResponseHead, emit: (p: ExecProgress) => void) {
  const contentType = getHeader(head.headers, 'content-type') ?? ''
  const streaming = STREAM_TYPES.test(contentType)
  const isText = TEXT_TYPES.test(contentType)
  let decoder = liveDecoder(getHeader(head.headers, 'content-encoding'))
  const text = new TextDecoder('utf-8')
  let headSent = false
  let pending = ''
  let textSent = 0
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const flush = (): void => {
    timer = undefined
    if (stopped) return
    if (!headSent) {
      headSent = true
      emit({ type: 'head', ...head })
    }
    emit({ type: 'data', text: pending, bytes })
    pending = ''
  }
  const onDecoded = (chunk: Buffer): void => {
    bytes += chunk.length
    // A compressed body that keeps expanding: stop decoding it for the live view.
    if (decoder && bytes > MAX_RESPONSE_BYTES) {
      decoder.destroy()
      decoder = false
    }
    if (isText && textSent < LIVE_TEXT_LIMIT) {
      const t = text.decode(chunk, { stream: true })
      pending += t
      textSent += t.length
    }
    timer ??= setTimeout(flush, LIVE_INTERVAL_MS)
  }
  if (decoder) {
    decoder.on('data', onDecoded)
    // Can't decode: keep counting bytes, show no text.
    decoder.on('error', () => (decoder = false))
  }
  // Event streams show up as soon as they open.
  if (streaming) timer = setTimeout(flush, 0)
  else timer = setTimeout(flush, LIVE_INTERVAL_MS)

  return {
    streaming,
    onChunk(chunk: Buffer): void {
      if (decoder) decoder.write(chunk)
      else if (decoder === null) onDecoded(chunk)
      else {
        bytes += chunk.length
        timer ??= setTimeout(flush, LIVE_INTERVAL_MS)
      }
    },
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      if (decoder) decoder.destroy()
    }
  }
}

/**
 * Sends a prepared request. With `onProgress`, the response is also reported
 * while it arrives; event streams are then exempt from the timeout, and
 * cancelling after the head arrived keeps what was received.
 */
export async function executeRequest(
  req: PreparedRequest,
  opts: ExecOptions,
  signal?: AbortSignal,
  jar?: CookieStore,
  onProgress?: (p: ExecProgress) => void
): Promise<ExecResult> {
  const ctl = new AbortController()
  const onCancel = (): void => ctl.abort(new ExecError('Request cancelled', 'ECANCELLED'))
  let timer: ReturnType<typeof setTimeout> | undefined
  let url: URL | undefined
  let route: ProxyRoute | null = null
  let live: ReturnType<typeof liveForwarder> | undefined
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
      route = await proxyFor(url, opts.proxy)
      const secureContext = url.protocol === 'https:' ? await secureContextFor(url, opts.certificates) : undefined
      const jarCookie = opts.useCookieJar && jar ? await jar.getCookieHeader(url.href) : ''
      const sent = hopHeaders(url, headers, jarCookie, contentType, data, method)
      const isRedirect = (head: ResponseHead): boolean =>
        opts.followRedirects && REDIRECT_STATUSES.has(head.status) && !!getHeader(head.headers, 'location')
      const hop = await sendOnce(url, method, sent, data, {
        opts,
        signal: ctl.signal,
        route,
        secureContext,
        keepPartial: !!onProgress,
        onHead: onProgress
          ? (head) => {
              if (isRedirect(head)) return undefined
              live = liveForwarder(head, onProgress)
              if (live.streaming && timer) {
                clearTimeout(timer)
                timer = undefined
              }
              return live.onChunk
            }
          : undefined
      })

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
        // Credentials stay with the origin they were meant for: a redirect to another
        // host, port or scheme (https → http included) drops them, as browsers do.
        if (next.origin !== url.origin) {
          headers = headers.filter(([k]) => !/^(authorization|cookie|host)$/i.test(k) && !SENSITIVE_HEADER.test(k))
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
          requestHeaders: sent,
          ...(hop.incomplete ? { incomplete: hop.incomplete } : {}),
          ...(route ? { proxy: route.label } : {})
        }
      }
    }
  } catch (err) {
    return { ok: false, error: friendlyError(err, url, route) }
  } finally {
    if (timer) clearTimeout(timer)
    live?.stop()
    signal?.removeEventListener('abort', onCancel)
  }
}
