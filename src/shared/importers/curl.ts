import { emptyBody, formField, kv, newRequest } from '../model'
import type { ApiRequest, Auth, FormField, KeyValue, RequestBody } from '../types'
import { paramsFromUrl, splitUrl, urlWithParams } from '../url'

// ---------------------------------------------------------------------------
// Tokenizer

const ANSI_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?'
}

/** Reads a `$'...'` string starting at the `$`; returns the value and the index after the closing quote. */
function readAnsiC(src: string, start: number): [string, number] {
  let out = ''
  let i = start + 2
  while (i < src.length && src[i] !== "'") {
    if (src[i] !== '\\' || i + 1 >= src.length) {
      out += src[i++]
      continue
    }
    const c = src[i + 1]
    i += 2
    if (c in ANSI_ESCAPES) {
      out += ANSI_ESCAPES[c]
    } else if (c === 'x' || c === 'u' || c === 'U') {
      const max = c === 'x' ? 2 : c === 'u' ? 4 : 8
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(src.slice(i))
      if (m) {
        out += String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff))
        i += m[0].length
      } else {
        out += `\\${c}`
      }
    } else if (/[0-7]/.test(c)) {
      const m = /^[0-7]{0,2}/.exec(src.slice(i))![0]
      out += String.fromCharCode(parseInt(c + m, 8) & 0xff)
      i += m.length
    } else if (c === 'c' && i < src.length) {
      out += String.fromCharCode(src.charCodeAt(i++) & 0x1f)
    } else {
      out += `\\${c}`
    }
  }
  return [out, i + 1]
}

/**
 * Splits a shell command line into words, handling quotes, `$'...'`, backslash
 * escapes and line continuations. With `cmd`, `""` inside double quotes is a literal quote.
 */
export function tokenize(src: string, cmd = false): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let i = 0
  const n = src.length
  const push = (): void => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      push()
      i++
    } else if (c === '\\') {
      const next = src[i + 1]
      if (next === '\n') i += 2
      else if (next === '\r' && src[i + 2] === '\n') i += 3
      else if (next === undefined) i++
      else {
        cur += next
        has = true
        i += 2
      }
    } else if (c === "'") {
      let end = src.indexOf("'", i + 1)
      if (end === -1) end = n
      cur += src.slice(i + 1, end)
      has = true
      i = end + 1
    } else if (c === '$' && src[i + 1] === "'") {
      const [value, next] = readAnsiC(src, i)
      cur += value
      has = true
      i = next
    } else if (c === '"') {
      has = true
      i++
      while (i < n) {
        const d = src[i]
        if (d === '"') {
          if (cmd && src[i + 1] === '"') {
            cur += '"'
            i += 2
            continue
          }
          i++
          break
        }
        if (d === '\\' && i + 1 < n) {
          const e = src[i + 1]
          if (e === '\n') {
            i += 2
            continue
          }
          if (e === '$' || e === '`' || e === '"' || e === '\\') {
            cur += e
            i += 2
            continue
          }
        }
        cur += d
        i++
      }
    } else if (c === '#' && !has) {
      while (i < n && src[i] !== '\n') i++
    } else {
      cur += c
      has = true
      i++
    }
  }
  push()
  return tokens
}

/** Undoes Windows cmd.exe caret escaping (`^"`, `^\n` continuations, `^^`). */
const unescapeCmd = (s: string): string => s.replace(/\^(\r?\n|[\s\S])/g, (_, ch: string) => (ch.startsWith('\n') || ch.startsWith('\r') ? '' : ch))

// ---------------------------------------------------------------------------
// Flags

const VALUE_FLAGS: Record<string, string> = {
  '-X': 'request',
  '--request': 'request',
  '-H': 'header',
  '--header': 'header',
  '-d': 'data',
  '--data': 'data',
  '--data-ascii': 'data',
  '--data-binary': 'data-binary',
  '--data-raw': 'data-raw',
  '--data-urlencode': 'data-urlencode',
  '--json': 'json',
  '-F': 'form',
  '--form': 'form',
  '--form-string': 'form-string',
  '-u': 'user',
  '--user': 'user',
  '-A': 'user-agent',
  '--user-agent': 'user-agent',
  '-e': 'referer',
  '--referer': 'referer',
  '-b': 'cookie',
  '--cookie': 'cookie',
  '--url': 'url',
  '-T': 'upload-file',
  '--upload-file': 'upload-file',
  '--oauth2-bearer': 'oauth2-bearer'
}

// Flags that take a value we don't use; listed so the value isn't mistaken for the URL.
const IGNORED_VALUE_FLAGS = new Set(
  (
    '-o --output -c --cookie-jar -m --max-time --connect-timeout -x --proxy -U --proxy-user --cacert --capath ' +
    '-E --cert --cert-type --key --key-type --pass --resolve --retry --retry-delay --retry-max-time -w --write-out ' +
    '-r --range -z --time-cond --limit-rate -K --config --interface --local-port -C --continue-at --max-filesize ' +
    '--max-redirs --ciphers --dns-servers --doh-url --noproxy --proxy-header --tls-max --unix-socket ' +
    '--abstract-unix-socket --aws-sigv4 -Q --quote -t --telnet-option -y --speed-time -Y --speed-limit --connect-to ' +
    '--hostpubmd5 --pinnedpubkey --request-target --sasl-authzid --service-name --socks4 --socks4a --socks5 ' +
    '--socks5-hostname --trace --trace-ascii --stderr --variable --expect100-timeout --happy-eyeballs-timeout-ms ' +
    '--keepalive-time --mail-from --mail-rcpt --mail-auth --netrc-file --output-dir --proto --proto-redir --preproxy ' +
    '--proxy-cacert --proxy-capath --proxy-cert --proxy-cert-type --proxy-key --proxy-key-type --proxy-pass ' +
    '--proxy-ciphers --proxy-tls13-ciphers --proxy-tlsuser --proxy-tlspassword --proxy-tlsauthtype --proxy-pinnedpubkey ' +
    '--proxy-service-name -D --dump-header --create-file-mode --delegation -P --ftp-port --krb --login-options ' +
    '--tls13-ciphers --curves --egd-file --random-file --engine --crlfile --tlsuser --tlspassword --tlsauthtype ' +
    '--ftp-account --ftp-alternative-to-user --ftp-method --ftp-ssl-ccc-mode --header-file --ech --ipfs-gateway ' +
    '--etag-compare --etag-save --json-file --parallel-max --rate ' +
    '--trace-config --url-query --hsts --alt-svc --dns-interface --dns-ipv4-addr --dns-ipv6-addr ' +
    '--proxy1.0'
  ).split(' ')
)

const SHORT_VALUE = new Set('XHdFuAebTocmxUEKwrzCDPQtyY'.split(''))

const looksLikeUrl = (s: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('{{') || /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s) || /^localhost(:\d+)?([/?#]|$)/i.test(s)

interface DataPart {
  value: string
  /** `@file` given to -d / --data-binary. */
  file?: string
}

interface Parsed {
  method?: string
  url?: string
  positionals: string[]
  headers: [string, string][]
  data: DataPart[]
  json: boolean
  form: FormField[]
  user?: string
  get: boolean
  head: boolean
  uploadFile?: string
  bearer?: string
}

function parseFormArg(arg: string, literal: boolean): FormField {
  const eq = arg.indexOf('=')
  const name = eq === -1 ? arg : arg.slice(0, eq)
  const value = eq === -1 ? '' : arg.slice(eq + 1)
  if (!literal && (value.startsWith('@') || value.startsWith('<'))) {
    // name=@"path";type=mime;filename=x
    let rest = value.slice(1)
    let path: string
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1)
      path = rest.slice(1, end === -1 ? undefined : end)
      rest = end === -1 ? '' : rest.slice(end + 1)
    } else {
      const semi = rest.indexOf(';')
      path = semi === -1 ? rest : rest.slice(0, semi)
      rest = semi === -1 ? '' : rest.slice(semi)
    }
    const f = formField(name, '', 'file')
    f.files = path ? [path] : []
    const type = /;\s*type=([^;]+)/.exec(rest)
    if (type) f.contentType = type[1].trim()
    return f
  }
  const f = formField(name, value, 'text')
  if (!literal) {
    const type = /;type=([^;]+)$/.exec(value)
    if (type) {
      f.value = value.slice(0, type.index)
      f.contentType = type[1].trim()
    }
  }
  return f
}

const encodeForm = (s: string): string => encodeURIComponent(s).replace(/%20/g, '+')

function applyFlag(p: Parsed, name: string, value: string): void {
  switch (name) {
    case 'request':
      p.method = value.toUpperCase()
      break
    case 'header': {
      const i = value.indexOf(':')
      if (i === -1) {
        // `-H 'X-Empty;'` sends an empty header
        if (value.endsWith(';')) p.headers.push([value.slice(0, -1).trim(), ''])
      } else {
        const key = value.slice(0, i).trim()
        if (key) p.headers.push([key, value.slice(i + 1).trim()])
      }
      break
    }
    case 'data':
    case 'data-binary':
      if (value.startsWith('@') && value.length > 1) p.data.push({ value: '', file: value.slice(1) })
      else p.data.push({ value })
      break
    case 'data-raw':
      p.data.push({ value })
      break
    case 'data-urlencode': {
      const eq = value.indexOf('=')
      if (eq === -1) p.data.push({ value: encodeForm(value) })
      else if (eq === 0) p.data.push({ value: encodeForm(value.slice(1)) })
      else p.data.push({ value: `${value.slice(0, eq)}=${encodeForm(value.slice(eq + 1))}` })
      break
    }
    case 'json':
      p.json = true
      p.data.push({ value })
      break
    case 'form':
    case 'form-string':
      p.form.push(parseFormArg(value, name === 'form-string'))
      break
    case 'user':
      p.user = value
      break
    case 'user-agent':
      p.headers.push(['User-Agent', value])
      break
    case 'referer':
      p.headers.push(['Referer', value.replace(/;auto$/, '')])
      break
    case 'cookie':
      // Without '=' the argument is a cookie file to read, which we can't do.
      if (value.includes('=')) p.headers.push(['Cookie', value])
      break
    case 'url':
      p.url = value
      break
    case 'upload-file':
      p.uploadFile = value
      break
    case 'oauth2-bearer':
      p.bearer = value
      break
  }
}

function applyBoolean(p: Parsed, flag: string): void {
  if (flag === '-G' || flag === '--get') p.get = true
  else if (flag === '-I' || flag === '--head') p.head = true
}

function parseArgs(args: string[]): Parsed {
  const p: Parsed = { positionals: [], headers: [], data: [], json: false, form: [], get: false, head: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      p.positionals.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      let flag = a
      let inline: string | undefined
      const eq = a.indexOf('=')
      if (eq !== -1 && (VALUE_FLAGS[a.slice(0, eq)] || IGNORED_VALUE_FLAGS.has(a.slice(0, eq)))) {
        flag = a.slice(0, eq)
        inline = a.slice(eq + 1)
      }
      const name = VALUE_FLAGS[flag]
      if (name) {
        applyFlag(p, name, inline ?? args[++i] ?? '')
      } else if (IGNORED_VALUE_FLAGS.has(flag)) {
        if (inline === undefined) i++
      } else {
        applyBoolean(p, flag)
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // Short flags may be clustered (-sSL) and values may be attached (-XPOST).
      for (let j = 1; j < a.length; j++) {
        const ch = a[j]
        const flag = `-${ch}`
        if (SHORT_VALUE.has(ch)) {
          const value = j + 1 < a.length ? a.slice(j + 1) : (args[++i] ?? '')
          const name = VALUE_FLAGS[flag]
          if (name) applyFlag(p, name, value)
          break
        }
        applyBoolean(p, flag)
      }
    } else {
      p.positionals.push(a)
    }
  }
  return p
}

// ---------------------------------------------------------------------------
// Request building

function safeDecode(s: string): string {
  const plus = s.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(plus)
  } catch {
    return plus
  }
}

export function parseUrlencoded(data: string): KeyValue[] {
  return data
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq === -1 ? kv(safeDecode(pair), '') : kv(safeDecode(pair.slice(0, eq)), safeDecode(pair.slice(eq + 1)))
    })
}

const looksUrlencoded = (s: string): boolean => /^[^=&\s{}[\]<>"]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(s)

function buildBody(p: Parsed, contentType: string): RequestBody {
  const body = emptyBody()
  if (p.form.length) {
    body.mode = 'formdata'
    body.formdata = p.form
    return body
  }
  const fileOnly = p.data.length === 1 && p.data[0].file !== undefined
  if (fileOnly || (p.uploadFile && !p.data.length)) {
    body.mode = 'binary'
    body.binaryPath = fileOnly ? p.data[0].file! : p.uploadFile!
    return body
  }
  if (!p.data.length) return body
  const data = p.data.map((d) => (d.file !== undefined ? `@${d.file}` : d.value)).join(p.json ? '' : '&')
  const ct = contentType.toLowerCase()
  const parsesAsJson = (): boolean => {
    const t = data.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return false
    try {
      JSON.parse(t)
      return true
    } catch {
      return false
    }
  }
  const raw = (lang: RequestBody['rawLanguage']): RequestBody => {
    body.mode = 'raw'
    body.rawLanguage = lang
    body.raw = data
    if (lang === 'json') {
      try {
        body.raw = JSON.stringify(JSON.parse(data), null, 2)
      } catch {
        // keep as typed (may contain {{variables}})
      }
    }
    return body
  }
  if (p.json || ct.includes('json')) return raw('json')
  if (ct.includes('x-www-form-urlencoded')) {
    body.mode = 'urlencoded'
    body.urlencoded = parseUrlencoded(data)
    return body
  }
  if (ct.includes('xml')) return raw('xml')
  if (ct.includes('html')) return raw('html')
  if (ct.includes('javascript')) return raw('javascript')
  if (!ct) {
    if (parsesAsJson()) return raw('json')
    if (looksUrlencoded(data)) {
      body.mode = 'urlencoded'
      body.urlencoded = parseUrlencoded(data)
      return body
    }
  }
  return raw('text')
}

function nameFor(method: string, url: string): string {
  if (!url) return 'Imported request'
  const { base } = splitUrl(url)
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') : base.replace(/^[^/]*/, '')
  return `${method} ${path || '/'}`
}

/** Parses a `curl ...` command (bash or Windows cmd flavour) into a request. */
export function parseCurl(command: string): ApiRequest {
  let src = command.replace(/^﻿/, '').trim()
  if (!/^curl(\.exe)?(\s|$|\^)/i.test(src)) throw new Error('Not a cURL command')
  const cmd = /\^\r?\n/.test(src) || /\^"/.test(src)
  if (cmd) src = unescapeCmd(src)
  const args = tokenize(src, cmd).slice(1)
  const p = parseArgs(args)

  let url = p.url ?? p.positionals.find(looksLikeUrl) ?? p.positionals[0] ?? ''

  if (p.get && p.data.length) {
    const query = p.data.map((d) => (d.file !== undefined ? `@${d.file}` : d.value)).join('&')
    const { base, query: q, hash } = splitUrl(url)
    url = `${base}?${q ? `${q}&` : ''}${query}${hash ? `#${hash}` : ''}`
    p.data = []
  }

  const method =
    p.method ?? (p.head ? 'HEAD' : p.get ? 'GET' : p.uploadFile ? 'PUT' : p.data.length || p.form.length ? 'POST' : 'GET')

  let auth: Auth | undefined
  const headers: KeyValue[] = []
  for (const [key, value] of p.headers) {
    const lower = key.toLowerCase()
    const bearer = /^bearer\s+(.+)$/i.exec(value)
    if (lower === 'authorization' && bearer && !auth) {
      auth = { type: 'bearer', bearer: { token: bearer[1].trim() } }
      continue
    }
    if (p.form.length && lower === 'content-type' && /^multipart\/form-data/i.test(value)) continue
    headers.push(kv(key, value))
  }
  if (p.json) {
    const has = (k: string): boolean => headers.some((h) => h.key.toLowerCase() === k)
    if (!has('content-type')) headers.push(kv('Content-Type', 'application/json'))
    if (!has('accept')) headers.push(kv('Accept', 'application/json'))
  }
  if (p.user !== undefined) {
    const i = p.user.indexOf(':')
    auth = {
      type: 'basic',
      basic: i === -1 ? { username: p.user, password: '' } : { username: p.user.slice(0, i), password: p.user.slice(i + 1) }
    }
  } else if (p.bearer !== undefined) {
    auth = { type: 'bearer', bearer: { token: p.bearer } }
  }

  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
  const params = paramsFromUrl(url, [])
  return newRequest({
    name: nameFor(method, url),
    method,
    url: urlWithParams(url, params),
    params,
    headers,
    body: buildBody(p, contentType),
    ...(auth ? { auth } : {})
  })
}
