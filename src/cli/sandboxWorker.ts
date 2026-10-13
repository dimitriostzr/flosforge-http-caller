// Entry point of the CLI's script worker. Import order matters: the shim must
// install `self` before the sandbox module runs.
import './workerShim'
import '../renderer/src/worker/sandbox'
