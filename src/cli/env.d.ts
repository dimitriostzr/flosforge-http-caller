/** The script sandbox bundled as one plain script for QuickJS (built by vite.cli.config.ts). */
declare module 'virtual:sandbox-guest' {
  const code: string
  export default code
}
