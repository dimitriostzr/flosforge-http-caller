import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportNative, importText } from '../src/shared/importers'
import { newCapture } from '../src/shared/model'

// End-to-end test of the built CLI (npm run build:cli) against a local server.

const CLI = resolve(__dirname, '../out/cli/index.cjs')
const built = existsSync(CLI)
const dir = mkdtempSync(join(tmpdir(), 'ffcaller-cli-'))
let server: Server
let base = ''

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) =>
    execFile('node', [CLI, ...args, '--no-color'], { timeout: 60000 }, (err, stdout, stderr) =>
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
  )
}

const collection = {
  info: { name: 'Local API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Login',
      request: { method: 'POST', url: '{{base}}/login', body: { mode: 'raw', raw: '{"user":"{{user}}"}', options: { raw: { language: 'json' } } } },
      event: [{ listen: 'test', script: { exec: ["pm.environment.set('token', pm.response.json().token)", "pm.test('logged in', () => pm.response.to.have.status(200))"] } }]
    },
    {
      name: 'Me',
      request: { method: 'GET', url: '{{base}}/me', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } },
      event: [{ listen: 'test', script: { exec: ["pm.test('is the user', () => pm.expect(pm.response.json().user).to.eql(pm.variables.get('user')))"] } }]
    }
  ]
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/login') return res.end(JSON.stringify({ token: `t-${JSON.parse(body).user}` }))
      if (req.url === '/echo') return res.end(JSON.stringify({ body }))
      if (req.url === '/me') {
        const token = (req.headers.authorization ?? '').replace('Bearer t-', '')
        return res.end(JSON.stringify({ user: token }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  writeFileSync(join(dir, 'collection.json'), JSON.stringify(collection))
  writeFileSync(
    join(dir, 'env.json'),
    JSON.stringify({ name: 'Local', _postman_variable_scope: 'environment', values: [{ key: 'base', value: base, enabled: true }, { key: 'user', value: 'ada', enabled: true }] })
  )
  writeFileSync(join(dir, 'users.csv'), 'user\nada\ngrace\n')
})

afterAll(() => server?.close())

describe.skipIf(!built)('CLI (built)', () => {
  it('runs a collection, chaining a token from one request to the next', async () => {
    const r = await cli('run', join(dir, 'collection.json'), '-e', join(dir, 'env.json'))
    expect(r.stdout).toContain('✓ logged in')
    expect(r.stdout).toContain('✓ is the user')
    expect(r.stdout).toContain('All requests passed.')
    expect(r.code).toBe(0)
  })

  it('runs once per data row, with the row overriding the environment', async () => {
    const report = join(dir, 'report.json')
    const r = await cli('run', join(dir, 'collection.json'), '-e', join(dir, 'env.json'), '-d', join(dir, 'users.csv'), '-r', 'json', '--reporter-json-export', report)
    expect(r.code).toBe(0)
    const json = JSON.parse(readFileSync(report, 'utf8'))
    expect(json.summary).toMatchObject({ iterations: 2, requests: 4, failedRequests: 0 })
    expect(json.steps.map((s: { url: string }) => s.url)).toEqual([`${base}/login`, `${base}/me`, `${base}/login`, `${base}/me`])
  })

  it('exits 1 when a test fails and 2 on usage errors', async () => {
    const r = await cli('run', join(dir, 'collection.json'), '-e', join(dir, 'env.json'), '--env-var', 'base=http://127.0.0.1:1')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('failed request')
    expect((await cli('run')).code).toBe(2)
    expect((await cli('run', join(dir, 'nope.json'))).code).toBe(2)
    expect((await cli('--bogus')).code).toBe(2)
  })

  it('goes through --proxy, and skips it for --noproxy hosts', async () => {
    const proxied = await cli('run', join(dir, 'collection.json'), '-e', join(dir, 'env.json'), '--proxy', 'http://127.0.0.1:1')
    expect(proxied.code).toBe(1)
    expect(proxied.stdout).toContain('Could not reach the proxy http://127.0.0.1:1')
    const bypassed = await cli('run', join(dir, 'collection.json'), '-e', join(dir, 'env.json'), '--proxy', 'http://127.0.0.1:1', '--noproxy', '127.0.0.1')
    expect(bypassed.code).toBe(0)
    expect((await cli('run', join(dir, 'collection.json'), '--ssl-client-key', 'k.pem')).code).toBe(2)
  })

  it('runs a flow from a backup, passing captures along', async () => {
    const [c] = importText(JSON.stringify(collection)).collections
    const [login, me] = c.items
    const flow = {
      id: 'f1',
      name: 'Sign in',
      description: '',
      createdAt: 0,
      updatedAt: 0,
      steps: [
        { id: 's1', kind: 'request' as const, enabled: true, collectionId: c.id, requestId: login.id, captures: [newCapture({ variable: 'captured', path: '$.token', scope: 'local' as const })] },
        { id: 's2', kind: 'request' as const, enabled: true, collectionId: c.id, requestId: me.id, expect: { source: 'variable' as const, path: 'captured', op: 'equals' as const, value: 't-ada' } }
      ]
    }
    writeFileSync(join(dir, 'backup.json'), JSON.stringify(exportNative([c], [], [flow])))
    const r = await cli('run', join(dir, 'backup.json'), '--flow', 'Sign in', '-e', join(dir, 'env.json'))
    expect(r.stdout).toContain('→ {{captured}} = t-ada')
    expect(r.stdout).toContain('All 2 steps passed')
    expect(r.code).toBe(0)
    const missing = await cli('run', join(dir, 'backup.json'), '--flow', 'Nope')
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('Available: Sign in')
  })
})

const scriptCollection = (name: string, exec: string, request: object = { method: 'GET', url: '{{base}}/me' }) => ({
  info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'R', request, event: [{ listen: 'test', script: { exec: exec.split('\n') } }] }]
})

describe.skipIf(!built)('CLI sandboxing (built)', () => {
  it("runs scripts where they can't reach Node, the environment or the file system", async () => {
    const probe = `
const tries = {
  importProcess: async () => (await import('node:process')).default.env.FFC_TEST_SECRET,
  importFs: async () => (await import('node:fs')).readFileSync('/etc/hostname', 'utf8'),
  globalProcess: () => process.env.FFC_TEST_SECRET,
  viaConstructor: () => this.constructor.constructor('return process')().env.FFC_TEST_SECRET,
  fetchIt: () => fetch('http://127.0.0.1:1/')
}
for (const [name, fn] of Object.entries(tries)) {
  let got
  try { got = await fn() } catch (e) { got = 'blocked' }
  pm.test(name + ' is blocked', () => pm.expect(got === undefined || got === 'blocked').to.be.true)
}
pm.test('the usual helpers still work', () => {
  pm.expect(CryptoJS.SHA256('a').toString()).to.have.length(64)
  pm.expect(btoa(atob('aGk='))).to.eql('aGk=')
  pm.expect(new URL('/p?q=1', 'https://x.test').searchParams.get('q')).to.eql('1')
  pm.expect(require('uuid').v4()).to.match(/^[0-9a-f-]{36}$/)
})`
    writeFileSync(join(dir, 'probe.json'), JSON.stringify(scriptCollection('Probe', probe)))
    process.env.FFC_TEST_SECRET = 'hunter2'
    try {
      const r = await cli('run', join(dir, 'probe.json'), '-e', join(dir, 'env.json'), '--verbose')
      expect(r.stdout).not.toContain('hunter2')
      expect(r.stdout).toContain('All requests passed.')
      expect(r.code).toBe(0)
    } finally {
      delete process.env.FFC_TEST_SECRET
    }
  })

  it('uploads files from the working directory only', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ffcaller-work-'))
    writeFileSync(join(work, 'inside.txt'), 'inside')
    const upload = (path: string) =>
      scriptCollection('Upload', "pm.test('sent the file', () => pm.expect(pm.response.json().body).to.eql('inside'))", {
        method: 'POST',
        url: '{{base}}/echo',
        body: { mode: 'file', file: { src: path } }
      })
    writeFileSync(join(dir, 'inside.json'), JSON.stringify(upload('inside.txt')))
    const ok = await cli('run', join(dir, 'inside.json'), '-e', join(dir, 'env.json'), '--working-dir', work)
    expect(ok.stdout).toContain('✓ sent the file')
    expect(ok.code).toBe(0)

    writeFileSync(join(dir, 'outside.json'), JSON.stringify(upload(join(dir, 'env.json'))))
    const refused = await cli('run', join(dir, 'outside.json'), '-e', join(dir, 'env.json'), '--working-dir', work)
    expect(refused.stdout).toContain('outside the working directory')
    expect(refused.code).toBe(1)
    writeFileSync(join(dir, 'escape.json'), JSON.stringify(upload('../x/../../etc/hostname')))
    expect((await cli('run', join(dir, 'escape.json'), '-e', join(dir, 'env.json'), '--working-dir', work)).stdout).toContain('outside the working directory')
  })

  it('strips terminal control sequences from what collections print', async () => {
    writeFileSync(join(dir, 'ansi.json'), JSON.stringify(scriptCollection('Ansi', String.raw`console.log('a\u001b]0;pwned\u0007b\u001b[2Jc\rd')`)))
    const r = await cli('run', join(dir, 'ansi.json'), '-e', join(dir, 'env.json'), '--verbose')
    expect(r.stdout).not.toMatch(/\u001b\]|\u0007|\u001b\[2J|\r/)
    expect(r.stdout).toContain('a␛]0;pwnedb␛[2Jcd')
  })
})

it.runIf(!built)('CLI tests skipped: run "npm run build:cli" first', () => {})
