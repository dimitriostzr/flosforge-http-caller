// The script sandbox as the CLI runs it: bundled into one plain script and
// evaluated inside QuickJS (see sandboxWorker.ts). Import order matters: the shim
// must install the worker globals before the sandbox module runs.
import './guestShim'
import '../renderer/src/worker/sandbox'
