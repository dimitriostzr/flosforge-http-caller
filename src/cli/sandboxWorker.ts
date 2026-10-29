import { randomBytes } from 'node:crypto'
import { parentPort } from 'node:worker_threads'
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import guest from 'virtual:sandbox-guest'

// The CLI's script worker. Scripts run inside QuickJS, a separate JavaScript
// interpreter compiled to WebAssembly, so a collection's scripts can't reach
// Node at all: no process, environment, require, import(), file system or
// sockets. They get the worker globals guestShim.ts provides, and the network
// only through pm.sendRequest, which this worker passes on to the CLI.
//
// The CLI starts one worker per script job and terminates it on a time limit,
// which also stops a script that loops forever.

const MEMORY_LIMIT = 1024 * 1024 * 1024
const STACK_LIMIT = 4 * 1024 * 1024

const port = parentPort!

async function main(): Promise<void> {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant)
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT)
  runtime.setMaxStackSize(STACK_LIMIT)
  const vm = runtime.newContext()
  const timers = new Map<number, NodeJS.Timeout>()

  type Impl = (...args: QuickJSHandle[]) => QuickJSHandle | { error: QuickJSHandle } | void
  const fn = (name: string, impl: Impl): QuickJSHandle => vm.newFunction(name, (...args) => impl(...args))
  const hostObject = vm.newObject()
  const define = (name: string, impl: Impl): void => {
    const f = fn(name, impl)
    vm.setProp(hostObject, name, f)
    f.dispose()
  }
  define('post', (json) => port.postMessage(JSON.parse(vm.getString(json))))
  define('timer', (id, ms) => {
    const n = vm.getNumber(id)
    clearTimeout(timers.get(n))
    timers.set(
      n,
      setTimeout(() => {
        timers.delete(n)
        callGuest('fire', vm.newNumber(n))
      }, vm.getNumber(ms))
    )
  })
  define('clearTimer', (id) => {
    const n = vm.getNumber(id)
    clearTimeout(timers.get(n))
    timers.delete(n)
  })
  define('randomBytes', (n) => vm.newString(randomBytes(Math.min(65536, Math.max(0, vm.getNumber(n) | 0))).toString('hex')))
  define('parseUrl', (input, base) => {
    const b = vm.typeof(base) === 'string' ? vm.getString(base) : undefined
    let u: URL
    try {
      u = new URL(vm.getString(input), b)
    } catch (e) {
      return { error: vm.newError((e as Error).message) }
    }
    const { href, protocol, username, password, host, hostname, port: p, pathname, search, hash, origin } = u
    return vm.newString(JSON.stringify({ href, protocol, username, password, host, hostname, port: p, pathname, search, hash, origin }))
  })
  vm.setProp(vm.global, '__host', hostObject)
  hostObject.dispose()

  evaluate(vm, guest, 'sandbox.js')
  const guestApi = vm.getProp(vm.global, '__guest')

  function callGuest(name: string, arg: QuickJSHandle): void {
    const f = vm.getProp(guestApi, name)
    const result = vm.callFunction(f, guestApi, arg)
    f.dispose()
    arg.dispose()
    // Errors here come from a script's own timer callback; the sandbox reports script errors itself.
    if (result.error) result.error.dispose()
    else result.value.dispose()
    runJobs(vm)
  }

  port.on('message', (msg: unknown) => callGuest('deliver', vm.newString(JSON.stringify(msg))))
}

function evaluate(vm: QuickJSContext, code: string, file: string): void {
  const result = vm.evalCode(code, file)
  if (result.error) {
    const err = vm.dump(result.error)
    result.error.dispose()
    throw new Error(`Script sandbox failed to start: ${typeof err === 'object' && err ? (err as Error).message : String(err)}`)
  }
  result.value.dispose()
  runJobs(vm)
}

function runJobs(vm: QuickJSContext): void {
  const result = vm.runtime.executePendingJobs()
  if (result.error) result.error.dispose()
}

main().catch((e) => {
  // Surfaces as a worker error, which the runner reports as a sandbox failure.
  setImmediate(() => {
    throw e
  })
})
