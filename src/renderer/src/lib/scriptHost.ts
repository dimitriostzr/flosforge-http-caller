import SandboxWorker from '../worker/sandbox?worker'
import { createScriptRunner, type WorkerLike } from '@shared/engine/scriptRunner'
import type { WorkerOutbound } from '@shared/engine/scriptTypes'

export { hasScripts } from '@shared/engine/scriptRunner'

/** The app's sandbox: a dedicated Web Worker; pm.sendRequest goes through the main process. */
function spawn(): WorkerLike {
  const worker = new SandboxWorker()
  return {
    postMessage: (msg) => worker.postMessage(msg),
    onMessage: (cb) => {
      worker.onmessage = (e: MessageEvent<WorkerOutbound>) => cb(e.data)
    },
    onError: (cb) => {
      worker.onerror = (e) => {
        e.preventDefault()
        cb(e.message)
      }
    },
    terminate: () => worker.terminate()
  }
}

export const runScripts = createScriptRunner({ spawn, send: (req, opts) => window.api.send(req, opts) })
