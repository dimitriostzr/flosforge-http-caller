import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
})

it.runIf(!built)('CLI tests skipped: run "npm run build:cli" first', () => {})
