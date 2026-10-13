import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Builds the command-line runner: two self-contained Node files (the CLI and its
// script worker) with every dependency bundled, so it runs with just Node.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
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
