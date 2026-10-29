export { decodeBody, getHeader } from '@shared/engine/body'

export type BodyKind = 'json' | 'xml' | 'html' | 'javascript' | 'css' | 'text' | 'image' | 'pdf' | 'binary'

export function detectKind(contentType: string | undefined, text: string | null): BodyKind {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.includes('application/pdf')) return 'pdf'
  if (ct.includes('json')) return 'json'
  if (ct.includes('html')) return 'html'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript'
  if (ct.includes('css')) return 'css'
  if (text !== null) {
    const t = text.trimStart()
    if ((t.startsWith('{') || t.startsWith('[')) && isJson(text)) return 'json'
    if (t.startsWith('<!DOCTYPE html') || t.startsWith('<html')) return 'html'
    if (t.startsWith('<?xml') || t.startsWith('<')) return 'xml'
  }
  if (ct.startsWith('text/') || !ct) return 'text'
  if (/octet-stream|zip|audio|video|font|protobuf|msgpack/.test(ct)) return 'binary'
  return 'text'
}

/** Heuristic: treats the body as binary if it has NUL bytes or lots of control chars in the first 1KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) ctrl++
  }
  return n > 0 && ctrl / n > 0.1
}

export function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Very small XML/HTML pretty printer: one tag per line, indented. Leaves text nodes intact. */
export function prettyXml(text: string): string {
  if (text.length > 2_000_000) return text
  const tokens = text.replace(/>\s+</g, '><').split(/(?=<)|(?<=>)/g)
  let depth = 0
  const out: string[] = []
  for (const raw of tokens) {
    const t = raw.trim()
    if (!t) continue
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1)
    out.push('  '.repeat(depth) + t)
    if (/^<[^!?/][^>]*[^/]>$/.test(t) && !/^<(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)\b/i.test(t))
      depth++
  }
  // Collapse <a>text</a> back onto one line.
  return out.join('\n').replace(/(<[^/!?][^>]*>)\n\s*([^<\n]+)\n\s*(<\/[^>]+>)/g, '$1$2$3')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function timeAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(at).toLocaleDateString()
}

export function statusTone(status: number): 'ok' | 'redirect' | 'client' | 'server' | 'info' {
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  if (status >= 300) return 'redirect'
  if (status >= 200) return 'ok'
  return 'info'
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export'
}

export function extensionFor(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase()
  const map: [string, string][] = [
    ['json', 'json'],
    ['html', 'html'],
    ['xml', 'xml'],
    ['javascript', 'js'],
    ['css', 'css'],
    ['png', 'png'],
    ['jpeg', 'jpg'],
    ['gif', 'gif'],
    ['webp', 'webp'],
    ['svg', 'svg'],
    ['pdf', 'pdf'],
    ['zip', 'zip'],
    ['csv', 'csv'],
    ['text/plain', 'txt']
  ]
  return map.find(([k]) => ct.includes(k))?.[1] ?? 'bin'
}
