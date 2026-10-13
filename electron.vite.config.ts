import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

// The dev server needs inline scripts (React refresh) and websockets (HMR),
// which the production CSP in index.html forbids. Loosen it in dev only.
const devCsp = (): Plugin => ({
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      .replace("connect-src 'self'", "connect-src 'self' ws: http://localhost:*")
})

export default defineConfig({
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: {
      alias: {
        ...shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), devCsp()],
    build: { minify: 'esbuild' },
    // Classic (non-module) worker so it loads the same way in dev and production.
    worker: { format: 'iife' }
  }
})
