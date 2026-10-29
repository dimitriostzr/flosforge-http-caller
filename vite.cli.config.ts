import { resolve } from 'node:path'
import { build, defineConfig, type Plugin, type Rollup } from 'vite'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

// The CLI runs scripts inside QuickJS, which takes one plain script. This builds
// the sandbox (src/cli/guest.ts and everything it imports) as a browser-style
// bundle and hands it to the worker as `import guest from 'virtual:sandbox-guest'`.
const GUEST = 'virtual:sandbox-guest'
function sandboxGuest(): Plugin {
  return {
    name: 'sandbox-guest',
    resolveId: (id) => (id === GUEST ? `\0${GUEST}` : undefined),
    async load(id) {
      if (id !== `\0${GUEST}`) return
      const out = (await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias },
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
          write: false,
          target: 'es2020',
          minify: 'esbuild',
          lib: { entry: resolve(__dirname, 'src/cli/guest.ts'), formats: ['iife'], name: 'FlosForgeSandbox', fileName: () => 'guest.js' }
        }
      })) as Rollup.RollupOutput | Rollup.RollupOutput[]
      const chunk = (Array.isArray(out) ? out[0] : out).output[0]
      return `export default ${JSON.stringify(chunk.code)}`
    }
  }
}

// Builds the command-line runner: two self-contained Node files (the CLI and its
// script worker) with every dependency bundled, so it runs with just Node.
export default defineConfig({
  resolve: { alias },
  plugins: [sandboxGuest()],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/cli',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/cli/index.ts'), sandbox: resolve(__dirname, 'src/cli/sandboxWorker.ts') },
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        banner: (chunk) => (chunk.name === 'index' ? '#!/usr/bin/env node' : '')
      }
    }
  }
})
