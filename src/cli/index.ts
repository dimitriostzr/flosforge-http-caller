import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { APP_NAME, APP_SLUG } from '@shared/app'
import { importText } from '@shared/importers'
import { findPath, flattenRequests } from '@shared/tree'
import type { Collection, Environment, ExecOptions, TreeItem, Variable } from '@shared/types'
import { runCollection, type RunItem, type RunStep } from '@shared/engine/collectionRun'
import { parseDataFile } from '@shared/engine/data'
import type { EngineDeps } from '@shared/engine/execute'
import { toJUnit, toJsonReport } from '@shared/engine/report'
import { createScriptRunner, type WorkerLike } from '@shared/engine/scriptRunner'
import type { WorkerOutbound } from '@shared/engine/scriptTypes'
import { toMap, type VarMap } from '@shared/engine/variables'
import { CookieStore } from '../main/cookies'
import { executeRequest as sendHttp, setUserAgent } from '../main/http'
import pkg from '../../package.json'

// `flosforge-caller run collection.json -e env.json` — runs a collection from a
// terminal or CI with the same engine as the app. Flags follow other runners' where
// they overlap, so existing CI scripts move over with little change.

const HELP = `${APP_NAME} ${pkg.version}: run API collections from the command line.

Usage
  flosforge-caller run <collection-file> [options]

The collection file can be a collection export (v1, v2.0, v2.1) or a
${APP_NAME} backup. Environment and globals files can be exports too.

Options
  -e, --environment <file|name>   Environment file, or an environment's name inside a backup file
  -g, --globals <file>            Globals file
  -d, --iteration-data <file>     CSV or JSON data file: one iteration per row
  -n, --iteration-count <n>       Number of iterations (ignored with a data file)
      --collection <name>         Which collection to run, when the file holds several
      --folder <name>             Run only this folder (repeatable)
      --env-var <key=value>       Set an environment variable (repeatable)
      --global-var <key=value>    Set a global variable (repeatable)
      --delay-request <ms>        Pause between requests
      --timeout-request <ms>      Request timeout (default 30000, 0 = none)
      --timeout-script <ms>       Script time limit (default 5000)
      --bail                      Stop at the first failure
  -k, --insecure                  Don't verify SSL certificates
      --no-cookies                Don't store or send cookies between requests
  -r, --reporters <list>          Comma-separated: cli, json, junit (default: cli)
      --reporter-json-export <f>  Where to write the JSON report
      --reporter-junit-export <f> Where to write the JUnit XML report
      --verbose                   Also print script logs
      --no-color                  Plain output
  -h, --help                      Show this help
  -v, --version                   Show the version

Exit code: 0 when everything passed, 1 when a request or test failed, 2 for usage errors.`

// --- Arguments -------------------------------------------------------------------

interface Args {
  command?: string
  file?: string
  environment?: string
  globals?: string
  data?: string
  iterations: number
  collection?: string
  folders: string[]
  envVars: [string, string][]
  globalVars: [string, string][]
  delayMs: number
  timeoutMs: number
  scriptTimeoutMs: number
  bail: boolean
  insecure: boolean
  cookies: boolean
  reporters: string[]
  jsonExport?: string
  junitExport?: string
  verbose: boolean
  color: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args | 'help' | 'version' {
  const a: Args = {
    iterations: 1,
    folders: [],
    envVars: [],
    globalVars: [],
    delayMs: 0,
    timeoutMs: 30000,
    scriptTimeoutMs: 5000,
    bail: false,
    insecure: false,
    cookies: true,
    reporters: ['cli'],
    verbose: false,
    color: !!process.stdout.isTTY && !process.env.NO_COLOR
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${arg} needs a value`)
      return v
    }
    const num = (): number => {
      const v = Number(value())
      if (!Number.isFinite(v) || v < 0) throw new UsageError(`${arg} needs a number`)
      return v
    }
    const pair = (): [string, string] => {
      const v = value()
      const eq = v.indexOf('=')
      if (eq < 1) throw new UsageError(`${arg} expects key=value`)
      return [v.slice(0, eq), v.slice(eq + 1)]
    }
    switch (arg) {
      case '-h':
      case '--help':
        return 'help'
      case '-v':
      case '--version':
        return 'version'
      case '-e':
      case '--environment':
        a.environment = value()
        break
      case '-g':
      case '--globals':
        a.globals = value()
        break
      case '-d':
      case '--iteration-data':
        a.data = value()
        break
      case '-n':
      case '--iteration-count':
        a.iterations = Math.max(1, Math.floor(num()))
        break
      case '--collection':
        a.collection = value()
        break
      case '--folder':
        a.folders.push(value())
        break
      case '--env-var':
        a.envVars.push(pair())
        break
      case '--global-var':
        a.globalVars.push(pair())
        break
      case '--delay-request':
        a.delayMs = num()
        break
      case '--timeout-request':
        a.timeoutMs = num()
        break
      case '--timeout-script':
        a.scriptTimeoutMs = num()
        break
      case '--bail':
        a.bail = true
        break
      case '-k':
      case '--insecure':
        a.insecure = true
        break
      case '--no-cookies':
        a.cookies = false
        break
      case '-r':
      case '--reporters':
        a.reporters = value()
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
        break
      case '--reporter-json-export':
        a.jsonExport = value()
        break
      case '--reporter-junit-export':
        a.junitExport = value()
        break
      case '--verbose':
        a.verbose = true
        break
      case '--no-color':
        a.color = false
        break
      default:
        if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}. See --help.`)
        positional.push(arg)
    }
  }
  ;[a.command, a.file] = positional
  for (const r of a.reporters)
    if (!['cli', 'json', 'junit'].includes(r)) throw new UsageError(`Unknown reporter "${r}" (use cli, json or junit)`)
  return a
}

// --- Output --------------------------------------------------------------------------

let useColor = false
const paint =
  (code: string) =>
  (s: string | number): string =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const dim = paint('2')
const bold = paint('1')
const cyan = paint('36')

const out = (s = ''): void => void process.stdout.write(s + '\n')
const ms = (n: number | undefined): string => (n === undefined ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`)
const bytes = (n: number | undefined): string =>
  n === undefined ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

// --- Loading ---------------------------------------------------------------------------

function read(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    throw new UsageError(`Could not read the ${what} file "${file}": ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`)
  }
}

function load(file: string, what: string): ReturnType<typeof importText> {
  try {
    return importText(read(file, what), basename(file))
  } catch (e) {
    if (e instanceof UsageError) throw e
    throw new UsageError(`The ${what} file "${file}" could not be read: ${(e as Error).message}`)
  }
}

function pickCollection(collections: Collection[], name?: string): Collection {
  if (!collections.length) throw new UsageError('The file has no collection in it.')
  if (name) {
    const c = collections.find((x) => x.name === name)
    if (!c) throw new UsageError(`No collection named "${name}". Available: ${collections.map((x) => x.name).join(', ')}`)
    return c
  }
  if (collections.length > 1)
    process.stderr.write(yellow(`The file has ${collections.length} collections; running "${collections[0].name}". Use --collection to pick another.\n`))
  return collections[0]
}

function pickEnvironment(arg: string | undefined, fromCollectionFile: Environment[]): Environment | null {
  if (!arg) return null
  const byName = fromCollectionFile.find((e) => e.name === arg)
  if (byName) return byName
  const loaded = load(arg, 'environment')
  if (!loaded.environments.length) throw new UsageError(`"${arg}" is not an environment export.`)
  return loaded.environments[0]
}

function findFolders(collection: Collection, names: string[]): RunItem[] {
  if (!names.length) return flattenRequests(collection.items)
  const all: TreeItem[] = []
  const walk = (items: TreeItem[]): void => items.forEach((i) => (all.push(i), i.kind === 'folder' && walk(i.items)))
  walk(collection.items)
  return names.flatMap((name) => {
    const folder = all.find((i) => i.kind === 'folder' && i.name === name)
    if (folder?.kind !== 'folder') throw new UsageError(`No folder named "${name}" in "${collection.name}".`)
    return flattenRequests(folder.items, [...(findPath(collection, folder.id)?.parents ?? []), folder])
  })
}

const withOverrides = (base: VarMap, pairs: [string, string][]): VarMap => ({ ...base, ...Object.fromEntries(pairs) })

// --- Engine ---------------------------------------------------------------------------------

function nodeEngine(cookies: CookieStore | undefined): EngineDeps {
  const send: EngineDeps['send'] = (req, opts) => sendHttp(req, opts, undefined, cookies)
  const spawn = (): WorkerLike => {
    const worker = new Worker(join(__dirname, 'sandbox.cjs'))
    return {
      postMessage: (msg) => worker.postMessage(msg),
      onMessage: (cb) => void worker.on('message', (m: WorkerOutbound) => cb(m)),
      onError: (cb) => void worker.on('error', (e) => cb(e.message)),
      terminate: () => void worker.terminate()
    }
  }
  return { send, runScripts: createScriptRunner({ spawn, send }) }
}

// --- Run --------------------------------------------------------------------------------------

async function run(args: Args): Promise<number> {
  if (args.command !== 'run' || !args.file) throw new UsageError('Usage: flosforge-caller run <collection-file> [options]. See --help.')
  const source = load(args.file, 'collection')
  const collection = pickCollection(source.collections, args.collection)
  const environment = pickEnvironment(args.environment, source.environments)
  const globals: Variable[] = args.globals ? load(args.globals, 'globals').globals : source.globals
  const data = args.data
    ? (() => {
        try {
          return parseDataFile(read(args.data!, 'data'), args.data)
        } catch (e) {
          throw new UsageError(`Data file "${args.data}": ${(e as Error).message}`)
        }
      })()
    : undefined
  const items = findFolders(collection, args.folders)
  if (!items.length) throw new UsageError('There are no requests to run.')

  setUserAgent(`${APP_SLUG}/${pkg.version}`)
  const opts: ExecOptions = {
    timeoutMs: args.timeoutMs,
    followRedirects: true,
    maxRedirects: 10,
    verifySsl: !args.insecure,
    useCookieJar: args.cookies
  }

  const totalIterations = data?.rows.length || args.iterations
  const multi = totalIterations > 1
  out()
  out(`${bold(APP_NAME)} ${dim('·')} ${bold(collection.name)}${environment ? dim(` · environment “${environment.name}”`) : ''}`)

  const steps: RunStep[] = []
  let lastIteration = -1
  let lastFolder = ''
  const summary = await runCollection({
    collection,
    items,
    scopes: {
      globals: withOverrides(toMap(globals), args.globalVars),
      collection: toMap(collection.variables),
      environment: withOverrides(toMap(environment?.variables), args.envVars),
      data: {},
      local: {}
    },
    options: {
      iterations: args.iterations,
      data: data?.rows,
      delayMs: args.delayMs,
      bail: args.bail,
      opts,
      scriptTimeoutMs: args.scriptTimeoutMs
    },
    deps: nodeEngine(args.cookies ? new CookieStore() : undefined),
    onStep: (step) => {
      steps.push(step)
      if (!args.reporters.includes('cli')) return
      if (multi && step.iteration !== lastIteration) {
        lastIteration = step.iteration
        lastFolder = ''
        out()
        out(cyan(`Iteration ${step.iteration + 1}/${totalIterations}`))
      }
      const folder = items[step.index].parents.map((p) => p.name).join(' / ')
      if (folder !== lastFolder) {
        lastFolder = folder
        out()
        out(folder ? bold(folder) : bold(collection.name))
      }
      printStep(step, args.verbose)
    }
  })
  if (args.reporters.includes('cli')) printSummary(summary, steps)
  if (args.reporters.includes('json')) {
    const file = args.jsonExport ?? `${APP_SLUG.toLowerCase()}-report.json`
    writeFileSync(file, JSON.stringify(toJsonReport(collection.name, summary, steps), null, 2))
    out(dim(`JSON report written to ${file}`))
  }
  if (args.reporters.includes('junit')) {
    const file = args.junitExport ?? `${APP_SLUG.toLowerCase()}-report.xml`
    writeFileSync(file, toJUnit(collection.name, summary, steps))
    out(dim(`JUnit report written to ${file}`))
  }
  return summary.failedRequests > 0 || summary.stoppedBecause === 'loop' ? 1 : 0
}

function printStep(s: RunStep, verbose: boolean): void {
  const mark = s.skipped ? dim('○') : s.passed ? green('✓') : red('✗')
  const status = s.status !== undefined ? `${s.status} ${s.statusText ?? ''}`.trim() : s.skipped ? 'skipped' : 'no response'
  const tone = s.status === undefined ? red : s.status >= 400 ? yellow : green
  out(`  ${mark} ${s.method.padEnd(6)} ${s.name}  ${dim('·')} ${tone(status)} ${dim(`${ms(s.timeMs)} ${bytes(s.sizeBytes)}`)}`)
  if (s.error) out(`      ${red(s.error)}`)
  for (const e of s.scriptErrors) if (e !== s.error && !s.error?.includes(e)) out(`      ${red(e)}`)
  for (const t of s.tests) {
    if (t.skipped) out(`      ${dim(`○ ${t.name} (skipped)`)}`)
    else if (t.passed) out(`      ${green('✓')} ${dim(t.name)}`)
    else out(`      ${red(`✗ ${t.name}`)}${t.error ? `\n        ${red(t.error)}` : ''}`)
  }
  if (verbose) for (const l of s.logs) out(`      ${dim(`[${l.level}] ${l.message}`)}`)
}

function printSummary(summary: Awaited<ReturnType<typeof runCollection>>, steps: RunStep[]): void {
  const rows: [string, number, number][] = [
    ['iterations', summary.iterations, 0],
    ['requests', summary.requests, summary.failedRequests],
    ['tests', summary.tests.passed + summary.tests.failed, summary.tests.failed]
  ]
  const w = [12, 10, 8]
  const line = (l: string, m: string, r: string): string => `${l}${'─'.repeat(w[0] + 2)}${m}${'─'.repeat(w[1] + 2)}${m}${'─'.repeat(w[2] + 2)}${r}`
  const cell = (s: string, i: number, right = false): string => (right ? s.padStart(w[i]) : s.padEnd(w[i]))
  out()
  out(line('┌', '┬', '┐'))
  out(`│ ${cell('', 0)} │ ${cell('executed', 1, true)} │ ${cell('failed', 2, true)} │`)
  out(line('├', '┼', '┤'))
  for (const [label, total, failed] of rows)
    out(`│ ${cell(label, 0)} │ ${cell(String(total), 1, true)} │ ${failed ? red(cell(String(failed), 2, true)) : cell(String(failed), 2, true)} │`)
  out(line('└', '┴', '┘'))
  out(`total run duration: ${ms(summary.finishedAt - summary.startedAt)} · average response: ${ms(summary.avgResponseMs)}`)
  if (summary.note) out(yellow(summary.note))

  const failures = steps.filter((s) => !s.passed)
  if (failures.length) {
    out()
    out(red(bold(`${failures.length} failed request${failures.length > 1 ? 's' : ''}:`)))
    failures.forEach((s, i) => {
      const why = s.error ?? s.scriptErrors[0] ?? s.tests.filter((t) => !t.passed && !t.skipped).map((t) => `${t.name}: ${t.error ?? 'failed'}`).join('; ')
      out(`  ${i + 1}. ${s.name}${summary.totalIterations > 1 ? dim(` (iteration ${s.iteration + 1})`) : ''}: ${why}`)
    })
  } else out(green(bold('All requests passed.')))
  out()
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exit(2)
  }
  if (parsed === 'help') return out(HELP)
  if (parsed === 'version') return out(pkg.version)
  useColor = parsed.color
  try {
    process.exitCode = await run(parsed)
  } catch (e) {
    process.stderr.write(red(`${(e as Error).message}\n`))
    process.exitCode = e instanceof UsageError ? 2 : 1
  }
}

void main()
