import { parentPort } from 'node:worker_threads'

// Makes a Node worker thread look like a Web Worker to the shared sandbox
// (self, postMessage, onmessage), then removes what browser workers don't have.
// Scripts in a CLI run should no more reach the process environment (CI secrets
// live there), the file system or the network than they can in the app; the
// network stays available only through pm.sendRequest.

const port = parentPort!
const g = globalThis as unknown as Record<string, unknown>
g.self = globalThis
g.postMessage = (msg: unknown) => port.postMessage(msg)
port.on('message', (data: unknown) => (g.onmessage as ((e: { data: unknown }) => void) | undefined)?.({ data }))

for (const name of ['process', 'require', 'module', 'Buffer', 'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true })
  } catch {
    // Not configurable here: leave it.
  }
}
